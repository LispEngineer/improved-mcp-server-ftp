import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  startFtpServer, startMcp, ftpArgs, resultText, sha256, sha256File, writeRandomFile, scratchDir,
  type TestFtpServer, type McpHandle,
} from "./helpers.js";

describe("localPath streaming (FTP)", () => {
  let srv: TestFtpServer;
  let mcp: McpHandle;
  let local: string;

  before(async () => {
    srv = await startFtpServer();
    mcp = await startMcp();
    local = scratchDir();
  });
  after(async () => {
    await mcp.close();
    await srv.close();
    fs.rmSync(local, { recursive: true, force: true });
  });

  test("50 MB random file round-trips by localPath with equal SHA-256 and no content in the results", async () => {
    const src = path.join(local, "big.bin");
    const digest = writeRandomFile(src, 50 * 1024 * 1024);

    const up = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "big.bin", localPath: src });
    assert.ok(!up.isError, resultText(up));
    assert.equal(sha256File(path.join(srv.root, "big.bin")), digest, "server-side copy differs");

    const dst = path.join(local, "big-back.bin");
    const down = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "big.bin", localPath: dst });
    assert.ok(!down.isError, resultText(down));
    assert.equal(sha256File(dst), digest, "downloaded copy differs");
    assert.equal(fs.statSync(dst).size, 50 * 1024 * 1024);

    // The results carry metadata only: a 50 MB payload would be tens of MB of text.
    for (const r of [up, down]) {
      const wire = JSON.stringify(r);
      assert.ok(wire.length < 4096, `result is ${wire.length} bytes; it must not contain file content`);
      assert.match(wire, new RegExp(digest), "result should report the SHA-256");
    }
    assert.equal(down.structuredContent?.content, undefined, "download result must not include content");
    assert.equal(down.structuredContent?.sha256, digest);
    assert.equal(down.structuredContent?.bytes, 50 * 1024 * 1024);
    assert.equal(down.structuredContent?.transferMode, "binary");
  });

  test("download refuses to overwrite an existing local file unless overwrite is true", async () => {
    fs.writeFileSync(path.join(srv.root, "ow.txt"), "REMOTE\n");
    const dst = path.join(local, "ow.txt");
    fs.writeFileSync(dst, "PRECIOUS LOCAL DATA");

    const refused = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "ow.txt", localPath: dst });
    assert.equal(refused.isError, true, "should refuse");
    assert.match(resultText(refused), /overwrite/i);
    assert.equal(fs.readFileSync(dst, "utf8"), "PRECIOUS LOCAL DATA", "existing file must be untouched");

    const allowed = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "ow.txt", localPath: dst, overwrite: true });
    assert.ok(!allowed.isError, resultText(allowed));
    assert.equal(fs.readFileSync(dst, "utf8"), "REMOTE\n");
    // no leftover partial files next to the target
    assert.deepEqual(fs.readdirSync(local).filter((n) => n.includes("part")), []);
  });

  test("download creates no directories and leaves nothing behind on failure", async () => {
    fs.writeFileSync(path.join(srv.root, "nd.txt"), "x");
    const missingDir = path.join(local, "no", "such", "dir");
    const r = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "nd.txt", localPath: path.join(missingDir, "f.txt") });
    assert.equal(r.isError, true);
    assert.equal(fs.existsSync(path.join(local, "no")), false, "directories must not be created implicitly");

    const missingRemote = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "does-not-exist.txt", localPath: path.join(local, "ghost.txt") });
    assert.equal(missingRemote.isError, true);
    assert.equal(fs.existsSync(path.join(local, "ghost.txt")), false, "a failed download must not leave a file");
    assert.deepEqual(fs.readdirSync(local).filter((n) => n.includes("ghost")), []);
  });

  test("upload of a missing or non-regular local path is a clear error", async () => {
    const r = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "x.bin", localPath: path.join(local, "nope.bin") });
    assert.equal(r.isError, true);
    assert.match(resultText(r), /nope\.bin/);
    const d = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "x.bin", localPath: local });
    assert.equal(d.isError, true);
    assert.match(resultText(d), /not a regular file/i);
  });

  test("relative localPath resolves against the server's working directory; ~ expands to the home directory", async () => {
    const cwdMcp = await startMcp();
    try {
      // The server under test inherits this process's cwd, so a path relative to it must work.
      const rel = path.relative(process.cwd(), path.join(local, "rel.txt"));
      fs.writeFileSync(path.join(local, "rel.txt"), "relative\n");
      const r = await cwdMcp.call("upload-file", { ...ftpArgs(srv), remotePath: "rel.txt", localPath: rel });
      assert.ok(!r.isError, resultText(r));
      assert.equal(fs.readFileSync(path.join(srv.root, "rel.txt"), "utf8"), "relative\n");
    } finally {
      await cwdMcp.close();
    }
    const home = scratchDir("mcp-ftp-test-home-");
    const homeMcp = await startMcp({ HOME: home });
    try {
      fs.writeFileSync(path.join(home, "tilde.txt"), "tilde\n");
      const r = await homeMcp.call("upload-file", { ...ftpArgs(srv), remotePath: "tilde.txt", localPath: "~/tilde.txt" });
      assert.ok(!r.isError, resultText(r));
      assert.equal(fs.readFileSync(path.join(srv.root, "tilde.txt"), "utf8"), "tilde\n");
    } finally {
      await homeMcp.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("append-file streams a local file onto the end of a remote file", async () => {
    fs.writeFileSync(path.join(srv.root, "ap.bin"), Buffer.from([1, 2, 3]));
    const src = path.join(local, "ap-src.bin");
    fs.writeFileSync(src, Buffer.from([4, 5, 6, 0x0a, 0x0d, 0x0a]));
    const r = await mcp.call("append-file", { ...ftpArgs(srv), remotePath: "ap.bin", localPath: src });
    assert.ok(!r.isError, resultText(r));
    assert.deepEqual([...fs.readFileSync(path.join(srv.root, "ap.bin"))], [1, 2, 3, 4, 5, 6, 0x0a, 0x0d, 0x0a]);
  });

  test("the transfer log records local path, byte count and SHA-256 of the local file, never its content", async () => {
    const marker = "SECRET-MARKER-DO-NOT-LOG-" + sha256("m").slice(0, 8);
    const src = path.join(local, "logged.txt");
    fs.writeFileSync(src, `${marker}\nsecond line\n`);
    const digest = sha256File(src);
    const size = fs.statSync(src).size;
    const args = { ...ftpArgs(srv), log_dir: mcp.logDir };

    assert.ok(!(await mcp.call("upload-file", { ...args, remotePath: "logged.txt", localPath: src })).isError);
    const dst = path.join(local, "logged-back.txt");
    assert.ok(!(await mcp.call("download-file", { ...args, remotePath: "logged.txt", localPath: dst })).isError);

    const log = fs.readFileSync(path.join(mcp.logDir, "ftp_transfers.log"), "utf8");
    assert.ok(!log.includes(marker), "file content must never be written to the transfer log");
    assert.ok(log.includes(src), "log should name the local source path");
    assert.ok(log.includes(dst), "log should name the local destination path");
    assert.ok(log.includes(digest), "log should carry the SHA-256 of the local file");
    assert.ok(log.includes(`${size} bytes`), "log should carry the byte count");
    assert.match(log, /UPLOAD - SUCCESS/);
    assert.match(log, /DOWNLOAD - SUCCESS/);
    assert.match(log, /local file/i, "log should say the size and hash are of the local file");
  });

  test("a failed localPath transfer is logged as FAILED without content", async () => {
    const dst = path.join(local, "fail.txt");
    const args = { ...ftpArgs(srv), log_dir: mcp.logDir };
    const r = await mcp.call("download-file", { ...args, remotePath: "definitely-missing.txt", localPath: dst });
    assert.equal(r.isError, true);
    const log = fs.readFileSync(path.join(mcp.logDir, "ftp_transfers.log"), "utf8");
    assert.match(log, /DOWNLOAD - FAILED/);
    assert.ok(log.includes(dst));
  });
});

describe("argument validation", () => {
  let mcp: McpHandle;
  let srv: TestFtpServer;
  before(async () => { srv = await startFtpServer(); mcp = await startMcp(); });
  after(async () => { await mcp.close(); await srv.close(); });

  for (const tool of ["upload-file", "append-file"]) {
    test(`${tool}: content together with localPath is rejected`, async () => {
      const r = await mcp.call(tool, { ...ftpArgs(srv), remotePath: "v.txt", content: "hi", localPath: "/etc/hostname" });
      assert.equal(r.isError, true);
      assert.match(resultText(r), /exactly one of/i);
      assert.equal(fs.existsSync(path.join(srv.root, "v.txt")), false, "nothing may be uploaded");
    });
    test(`${tool}: neither content nor localPath is rejected`, async () => {
      const r = await mcp.call(tool, { ...ftpArgs(srv), remotePath: "v.txt" });
      assert.equal(r.isError, true);
      assert.match(resultText(r), /exactly one of/i);
    });
    test(`${tool}: encoding with localPath is rejected`, async () => {
      const r = await mcp.call(tool, { ...ftpArgs(srv), remotePath: "v.txt", localPath: "/etc/hostname", encoding: "base64" });
      assert.equal(r.isError, true);
      assert.match(resultText(r), /encoding/i);
    });
    test(`${tool}: empty content is still valid content`, async () => {
      const r = await mcp.call(tool, { ...ftpArgs(srv), remotePath: "empty.txt", content: "" });
      assert.ok(!r.isError, resultText(r));
      assert.equal(fs.readFileSync(path.join(srv.root, "empty.txt")).length, 0);
    });
  }

  test("download-file: overwrite without localPath is rejected", async () => {
    fs.writeFileSync(path.join(srv.root, "d.txt"), "d");
    const r = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "d.txt", overwrite: true });
    assert.equal(r.isError, true);
    assert.match(resultText(r), /localPath/);
  });

  for (const [tool, extra] of [
    ["upload-file", { content: "x" }],
    ["append-file", { content: "x" }],
    ["download-file", {}],
  ] as const) {
    test(`${tool}: transferMode ascii is rejected for SFTP before any connection is made`, async () => {
      // Port 1 is closed; a connection attempt would produce "ECONNREFUSED", not this message.
      const r = await mcp.call(tool, { host: "127.0.0.1", port: 1, protocol: "sftp", user: "u", password: "p", remotePath: "s.txt", transferMode: "ascii", ...extra });
      assert.equal(r.isError, true);
      assert.match(resultText(r), /SFTP has no ASCII/i);
    });
  }

  test("an unknown transferMode value is rejected", async () => {
    const r = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "t.txt", content: "x", transferMode: "ebcdic" });
    assert.equal(r.isError, true);
    assert.equal(fs.existsSync(path.join(srv.root, "t.txt")), false);
  });
});

describe("content-based calls keep working", () => {
  let srv: TestFtpServer;
  let mcp: McpHandle;
  before(async () => { srv = await startFtpServer(); mcp = await startMcp(); });
  after(async () => { await mcp.close(); await srv.close(); });

  test("utf8 upload, download, list, edit, delete", async () => {
    const up = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "c.txt", content: "h\u00e9llo\nworld\n" });
    assert.ok(!up.isError, resultText(up));
    assert.equal(fs.readFileSync(path.join(srv.root, "c.txt"), "utf8"), "h\u00e9llo\nworld\n");
    assert.equal(up.structuredContent?.bytesWritten, Buffer.byteLength("h\u00e9llo\nworld\n"));

    const down = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "c.txt" });
    assert.ok(!down.isError, resultText(down));
    assert.equal(down.structuredContent?.content, "h\u00e9llo\nworld\n");
    assert.equal(down.structuredContent?.encoding, "utf8");

    const list = await mcp.call("list-directory", { ...ftpArgs(srv), remotePath: "." });
    assert.match(resultText(list), /c\.txt/);

    const edit = await mcp.call("edit-file", { ...ftpArgs(srv), remotePath: "c.txt", oldText: "world", newText: "there" });
    assert.ok(!edit.isError, resultText(edit));
    assert.equal(fs.readFileSync(path.join(srv.root, "c.txt"), "utf8"), "h\u00e9llo\nthere\n");

    const del = await mcp.call("delete-file", { ...ftpArgs(srv), remotePath: "c.txt" });
    assert.ok(!del.isError, resultText(del));
    assert.equal(fs.existsSync(path.join(srv.root, "c.txt")), false);
  });

  test("base64 upload and download of binary content is byte-exact", async () => {
    const bytes = Buffer.from([0, 1, 2, 0x0a, 0x0d, 0x0a, 0xff, 0xfe, 0x80]);
    const up = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "b.bin", content: bytes.toString("base64"), encoding: "base64" });
    assert.ok(!up.isError, resultText(up));
    assert.deepEqual(fs.readFileSync(path.join(srv.root, "b.bin")), bytes);
    const down = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "b.bin" });
    assert.equal(down.structuredContent?.encoding, "base64");
    assert.deepEqual(Buffer.from(down.structuredContent?.content, "base64"), bytes);
  });

  test("append with content, and the existing log line format, are intact", async () => {
    fs.writeFileSync(path.join(srv.root, "a.txt"), "one\n");
    const r = await mcp.call("append-file", { ...ftpArgs(srv), remotePath: "a.txt", content: "two\n", log_dir: mcp.logDir });
    assert.ok(!r.isError, resultText(r));
    assert.equal(fs.readFileSync(path.join(srv.root, "a.txt"), "utf8"), "one\ntwo\n");
    const log = fs.readFileSync(path.join(mcp.logDir, "ftp_transfers.log"), "utf8");
    assert.match(log, /\] FTP TRANSFER: APPEND - SUCCESS/);
    assert.match(log, /^Target       : 127\.0\.0\.1:\d+ \(tester\)$/m);
    assert.match(log, /^Remote Path  : a\.txt$/m);
    assert.match(log, /^SHA-256      : [0-9a-f]{64}$/m);
  });
});
