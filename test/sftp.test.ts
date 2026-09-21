/**
 * SFTP against a real OpenSSH sshd on a loopback port, run unprivileged with a
 * throw-away host key and client key, key-only auth, for the current user only.
 * Skipped (not failed) where sshd or ssh-keygen is not installed.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { startMcp, resultText, sha256File, writeRandomFile, scratchDir, type McpHandle } from "./helpers.js";

const SSHD = ["/usr/bin/sshd", "/usr/sbin/sshd"].find((p) => fs.existsSync(p));
const haveTools = Boolean(SSHD) && spawnSync("ssh-keygen", ["-V"], { stdio: "ignore" }).error === undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () => { c.destroy(); resolve(true); });
      c.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("sshd did not start listening");
}

describe("SFTP localPath (real sshd on loopback)", { skip: !haveTools && "sshd or ssh-keygen not installed" }, () => {
  let sshd: ChildProcess;
  let port: number;
  let dir: string;
  let mcp: McpHandle;
  let remote: string; // a directory the sshd user can see: SFTP paths are real local paths here
  const user = os.userInfo().username;

  before(async () => {
    dir = scratchDir("mcp-ftp-test-sshd-");
    remote = scratchDir("mcp-ftp-test-sftp-remote-");
    for (const name of ["hostkey", "clientkey"]) {
      const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, name)]);
      assert.equal(r.status, 0, String(r.stderr));
    }
    fs.copyFileSync(path.join(dir, "clientkey.pub"), path.join(dir, "authorized_keys"));
    port = await freePort();
    fs.writeFileSync(path.join(dir, "sshd_config"), [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${path.join(dir, "hostkey")}`,
      `PidFile ${path.join(dir, "sshd.pid")}`,
      `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
      "PasswordAuthentication no",
      "PubkeyAuthentication yes",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "StrictModes no",
      `AllowUsers ${user}`,
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"));
    sshd = spawn(SSHD!, ["-D", "-e", "-f", path.join(dir, "sshd_config")], { stdio: "ignore" });
    await waitForPort(port);
    mcp = await startMcp({ FTP_PRIVATE_KEY_PATH: path.join(dir, "clientkey") });
  });
  after(async () => {
    await mcp?.close();
    if (sshd && sshd.exitCode === null) {
      // Wait for it to exit: it removes its own pid file on the way out, and deleting
      // the directory underneath it at the same moment can leave the directory behind.
      await new Promise<void>((resolve) => {
        sshd.once("exit", () => resolve());
        sshd.kill();
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  const conn = () => ({ host: "127.0.0.1", port, protocol: "sftp", user, password: "" });

  test("a 5 MB file round-trips by localPath with equal SHA-256 and metadata-only results", async () => {
    const src = path.join(dir, "src.bin");
    const digest = writeRandomFile(src, 5 * 1024 * 1024);
    const up = await mcp.call("upload-file", { ...conn(), remotePath: path.join(remote, "r.bin"), localPath: src });
    assert.ok(!up.isError, resultText(up));
    assert.equal(sha256File(path.join(remote, "r.bin")), digest);
    assert.equal(up.structuredContent?.sha256, digest);

    const dst = path.join(dir, "back.bin");
    const down = await mcp.call("download-file", { ...conn(), remotePath: path.join(remote, "r.bin"), localPath: dst });
    assert.ok(!down.isError, resultText(down));
    assert.equal(sha256File(dst), digest);
    assert.equal(down.structuredContent?.sha256, digest);
    assert.equal(down.structuredContent?.bytes, 5 * 1024 * 1024);
    assert.ok(JSON.stringify(down).length < 4096, "no file content in the result");
  });

  test("download refuses to overwrite unless overwrite is true, and leaves no partial file", async () => {
    fs.writeFileSync(path.join(remote, "o.txt"), "REMOTE");
    const dst = path.join(dir, "o.txt");
    fs.writeFileSync(dst, "LOCAL");
    const refused = await mcp.call("download-file", { ...conn(), remotePath: path.join(remote, "o.txt"), localPath: dst });
    assert.equal(refused.isError, true);
    assert.match(resultText(refused), /overwrite/i);
    assert.equal(fs.readFileSync(dst, "utf8"), "LOCAL");
    const ok = await mcp.call("download-file", { ...conn(), remotePath: path.join(remote, "o.txt"), localPath: dst, overwrite: true });
    assert.ok(!ok.isError, resultText(ok));
    assert.equal(fs.readFileSync(dst, "utf8"), "REMOTE");

    const missing = await mcp.call("download-file", { ...conn(), remotePath: path.join(remote, "nope"), localPath: path.join(dir, "ghost") });
    assert.equal(missing.isError, true);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes("ghost")), []);
  });

  test("append-file streams a local file onto a remote one", async () => {
    fs.writeFileSync(path.join(remote, "a.bin"), Buffer.from([1, 2]));
    const src = path.join(dir, "a-src.bin");
    fs.writeFileSync(src, Buffer.from([3, 0x0a, 4]));
    const r = await mcp.call("append-file", { ...conn(), remotePath: path.join(remote, "a.bin"), localPath: src });
    assert.ok(!r.isError, resultText(r));
    assert.deepEqual([...fs.readFileSync(path.join(remote, "a.bin"))], [1, 2, 3, 0x0a, 4]);
  });

  test("content upload and download over SFTP still work; ascii is refused", async () => {
    const up = await mcp.call("upload-file", { ...conn(), remotePath: path.join(remote, "c.txt"), content: "hi\n" });
    assert.ok(!up.isError, resultText(up));
    assert.equal(fs.readFileSync(path.join(remote, "c.txt"), "utf8"), "hi\n");
    assert.equal(up.structuredContent?.transferMode, "binary");
    const down = await mcp.call("download-file", { ...conn(), remotePath: path.join(remote, "c.txt") });
    assert.equal(down.structuredContent?.content, "hi\n");
    const ascii = await mcp.call("upload-file", { ...conn(), remotePath: path.join(remote, "x.txt"), content: "x", transferMode: "ascii" });
    assert.equal(ascii.isError, true);
    assert.match(resultText(ascii), /SFTP has no ASCII/i);
    assert.equal(fs.existsSync(path.join(remote, "x.txt")), false);
  });
});
