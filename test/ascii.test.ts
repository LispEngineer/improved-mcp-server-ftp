import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Client } from "basic-ftp";
import {
  startFtpServer, startMcp, ftpArgs, resultText, sha256, sha256File, scratchDir, TEST_USER, TEST_PASSWORD,
  type TestFtpServer, type McpHandle,
} from "./helpers.js";

describe("ASCII transfer mode (FTP)", () => {
  let srv: TestFtpServer;
  let mcp: McpHandle;
  let local: string;
  before(async () => { srv = await startFtpServer(); mcp = await startMcp(); local = scratchDir(); });
  after(async () => { await mcp.close(); await srv.close(); fs.rmSync(local, { recursive: true, force: true }); });

  const lastTransfer = () => srv.transfers[srv.transfers.length - 1];

  test("ASCII upload of an LF-only local file puts CR LF on the wire and TYPE A was in force", async () => {
    const src = path.join(local, "lf.com");
    fs.writeFileSync(src, "$ WRITE SYS$OUTPUT \"one\"\n$ WRITE SYS$OUTPUT \"two\"\n$ EXIT\n");
    const before = srv.transfers.length;
    const r = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "lf.com", localPath: src, transferMode: "ascii" });
    assert.ok(!r.isError, resultText(r));
    assert.equal(srv.transfers.length, before + 1);
    assert.equal(lastTransfer().type, "ascii", "server must have seen TYPE A");
    assert.equal(
      fs.readFileSync(path.join(srv.root, "lf.com"), "latin1"),
      "$ WRITE SYS$OUTPUT \"one\"\r\n$ WRITE SYS$OUTPUT \"two\"\r\n$ EXIT\r\n",
    );
    // Reported size and hash are of the LOCAL file, not of the (longer) wire form.
    const localBytes = fs.statSync(src).size;
    assert.equal(r.structuredContent?.bytesWritten, localBytes);
    assert.equal(r.structuredContent?.sha256, sha256File(src));
    assert.equal(r.structuredContent?.transferMode, "ascii");
    assert.equal(r.structuredContent?.wireBytes, localBytes + 3);
  });

  test("ASCII upload does not double an existing CR LF, and leaves a lone CR alone", async () => {
    const src = path.join(local, "mixed.txt");
    fs.writeFileSync(src, Buffer.from("a\r\nb\nc\rd\n\n", "latin1"));
    const r = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "mixed.txt", localPath: src, transferMode: "ascii" });
    assert.ok(!r.isError, resultText(r));
    assert.equal(fs.readFileSync(path.join(srv.root, "mixed.txt"), "latin1"), "a\r\nb\r\nc\rd\r\n\r\n");
  });

  test("ASCII upload of content (not localPath) is converted too", async () => {
    const r = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "content.txt", content: "x\ny\n", transferMode: "ascii" });
    assert.ok(!r.isError, resultText(r));
    assert.equal(fs.readFileSync(path.join(srv.root, "content.txt"), "latin1"), "x\r\ny\r\n");
    assert.equal(lastTransfer().type, "ascii");
    assert.equal(r.structuredContent?.bytesWritten, 4, "bytesWritten stays the local (pre-conversion) size");
  });

  test("ASCII download turns CR LF into LF, to a local file and as returned content", async () => {
    fs.writeFileSync(path.join(srv.root, "crlf.txt"), Buffer.from("l1\r\nl2\r\n\r\nlone\rcr\r\n", "latin1"));
    const dst = path.join(local, "crlf-back.txt");
    const r = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "crlf.txt", localPath: dst, transferMode: "ascii" });
    assert.ok(!r.isError, resultText(r));
    assert.equal(lastTransfer().type, "ascii");
    assert.equal(fs.readFileSync(dst, "latin1"), "l1\nl2\n\nlone\rcr\n");
    assert.equal(r.structuredContent?.sha256, sha256(Buffer.from("l1\nl2\n\nlone\rcr\n", "latin1")), "hash is of the local file");
    assert.equal(r.structuredContent?.bytes, fs.statSync(dst).size);

    const c = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "crlf.txt", transferMode: "ascii" });
    assert.equal(c.structuredContent?.content, "l1\nl2\n\nlone\rcr\n");
  });

  test("ASCII append converts too", async () => {
    fs.writeFileSync(path.join(srv.root, "app.txt"), "first\r\n");
    const src = path.join(local, "app-src.txt");
    fs.writeFileSync(src, "second\nthird\n");
    const r = await mcp.call("append-file", { ...ftpArgs(srv), remotePath: "app.txt", localPath: src, transferMode: "ascii" });
    assert.ok(!r.isError, resultText(r));
    assert.equal(fs.readFileSync(path.join(srv.root, "app.txt"), "latin1"), "first\r\nsecond\r\nthird\r\n");
    assert.equal(lastTransfer().command, "APPE");
    assert.equal(lastTransfer().type, "ascii");
  });

  test("a binary transfer straight after an ASCII one is byte-exact and uses TYPE I", async () => {
    const bytes = Buffer.from([0x41, 0x0a, 0x42, 0x0d, 0x0a, 0x43, 0x0a, 0x00, 0xff]);
    const src = path.join(local, "after.bin");
    fs.writeFileSync(src, bytes);
    const a = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "first.txt", content: "t\n", transferMode: "ascii" });
    assert.ok(!a.isError);
    const b = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "after.bin", localPath: src });
    assert.ok(!b.isError, resultText(b));
    assert.equal(lastTransfer().type, "binary");
    assert.deepEqual(fs.readFileSync(path.join(srv.root, "after.bin")), bytes);
    const dst = path.join(local, "after-back.bin");
    const c = await mcp.call("download-file", { ...ftpArgs(srv), remotePath: "after.bin", localPath: dst });
    assert.ok(!c.isError);
    assert.deepEqual(fs.readFileSync(dst), bytes);
  });

  test("default transferMode is binary: an LF-only file is not converted", async () => {
    const r = await mcp.call("upload-file", { ...ftpArgs(srv), remotePath: "plain.txt", content: "p\nq\n" });
    assert.ok(!r.isError, resultText(r));
    assert.equal(fs.readFileSync(path.join(srv.root, "plain.txt"), "latin1"), "p\nq\n");
    assert.equal(lastTransfer().type, "binary");
    assert.equal(r.structuredContent?.transferMode, "binary");
  });

  test("the log states the mode", async () => {
    const args = { ...ftpArgs(srv), log_dir: mcp.logDir };
    await mcp.call("upload-file", { ...args, remotePath: "m.txt", content: "m\n", transferMode: "ascii" });
    const log = fs.readFileSync(path.join(mcp.logDir, "ftp_transfers.log"), "utf8");
    assert.match(log, /^Mode         : ASCII/m);
  });
});

describe("TYPE restoration on a reused connection", () => {
  let srv: TestFtpServer;
  before(async () => { srv = await startFtpServer(); });
  after(async () => { await srv.close(); });

  test("withTransferType leaves the connection in TYPE I so a following binary transfer is not corrupted", async () => {
    const mod: any = await import("../src/ftp-client.js");
    assert.equal(typeof mod.withTransferType, "function", "ftp-client must export withTransferType");
    const c = new Client();
    try {
      await c.access({ host: "127.0.0.1", port: srv.port, user: TEST_USER, password: TEST_PASSWORD });
      const { Readable } = await import("stream");
      await mod.withTransferType(c, "ascii", () => c.uploadFrom(Readable.from([Buffer.from("t\r\n")]), "text.txt"));
      assert.equal(srv.transfers.at(-1)!.type, "ascii");
      const bin = Buffer.from([1, 0x0a, 2, 0x0d, 0x0a]);
      await c.uploadFrom(Readable.from([bin]), "bin.dat"); // same connection, plain call afterwards
      assert.equal(srv.transfers.at(-1)!.type, "binary", "TYPE I must have been restored");
      assert.deepEqual(fs.readFileSync(path.join(srv.root, "bin.dat")), bin);
    } finally {
      c.close();
    }
  });

  test("the restore also happens when the ASCII operation fails", async () => {
    const mod: any = await import("../src/ftp-client.js");
    const c = new Client();
    try {
      await c.access({ host: "127.0.0.1", port: srv.port, user: TEST_USER, password: TEST_PASSWORD });
      await assert.rejects(mod.withTransferType(c, "ascii", async () => { throw new Error("boom"); }), /boom/);
      const { Readable } = await import("stream");
      await c.uploadFrom(Readable.from([Buffer.from("z")]), "z.dat");
      assert.equal(srv.transfers.at(-1)!.type, "binary");
    } finally {
      c.close();
    }
  });
});

// A variable specifier keeps tsc from failing at compile time when the module does not exist
// yet (as in 1.4.0), so the tests fail at run time instead, which is the evidence wanted.
const TEXT_MODE_MODULE = "../src/text-mode.js";

describe("line-ending converters (chunk boundaries)", () => {
  const toBuf = (s: string) => Buffer.from(s, "latin1");
  const run = (conv: any, chunks: string[], flush = false) =>
    Buffer.concat([...chunks.map((c) => conv.convert(toBuf(c))), ...(flush ? [conv.flush()] : [])]).toString("latin1");

  test("LfToCrlf: LF becomes CR LF, CR LF is kept, wherever the chunk boundaries fall", async () => {
    const mod: any = await import(TEXT_MODE_MODULE);
    const whole = "a\nb\r\nc\r\n\nd\r";
    const expected = "a\r\nb\r\nc\r\n\r\nd\r";
    assert.equal(run(new mod.LfToCrlf(), [whole]), expected);
    // Every split point of every 2-way and per-byte split gives the same answer.
    for (let i = 0; i <= whole.length; i++) {
      assert.equal(run(new mod.LfToCrlf(), [whole.slice(0, i), whole.slice(i)]), expected, `split at ${i}`);
    }
    assert.equal(run(new mod.LfToCrlf(), whole.split("")), expected, "one byte at a time");
  });

  test("CrlfToLf: CR LF becomes LF, a lone CR is kept, wherever the chunk boundaries fall", async () => {
    const mod: any = await import(TEXT_MODE_MODULE);
    const whole = "a\r\nb\rc\r\n\r\nd\r";
    const expected = "a\nb\rc\n\nd\r";
    assert.equal(run(new mod.CrlfToLf(), [whole], true), expected);
    for (let i = 0; i <= whole.length; i++) {
      assert.equal(run(new mod.CrlfToLf(), [whole.slice(0, i), whole.slice(i)], true), expected, `split at ${i}`);
    }
    assert.equal(run(new mod.CrlfToLf(), whole.split(""), true), expected, "one byte at a time");
  });

  test("the two converters are inverses on text with no lone CR", async () => {
    const mod: any = await import(TEXT_MODE_MODULE);
    const text = "line one\nline two\n\n\nlast\n";
    const wire = run(new mod.LfToCrlf(), [text]);
    assert.equal(run(new mod.CrlfToLf(), [wire], true), text);
  });
});
