/**
 * Test harness: a throw-away FTP server (ftp-srv) on a loopback ephemeral port,
 * and the real MCP server (build-test/src/index.js) driven over stdio by the
 * MCP SDK client, so tests exercise exactly what an agent's tool call does.
 *
 * ftp-srv stores the bytes it receives without translating anything for
 * `TYPE A`, so what lands in its root directory is what was on the wire.
 * The credentials below are throw-away literals for the loopback server only.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FtpSrv, FileSystem } from "ftp-srv";

export const TEST_USER = "tester";
export const TEST_PASSWORD = "loopback-only-secret";

const here = path.dirname(fileURLToPath(import.meta.url));
// build-test/test/helpers.js -> build-test/src/index.js. MCP_FTP_SERVER_JS overrides it.
export const SERVER_JS = process.env.MCP_FTP_SERVER_JS || path.resolve(here, "../src/index.js");

export interface WireTransfer {
  command: "STOR" | "APPE" | "RETR";
  name: string;
  type: string; // ftp-srv's view of TYPE at the moment the transfer began: "ascii" | "binary"
}

export interface TestFtpServer {
  port: number;
  root: string;
  transfers: WireTransfer[];
  close(): Promise<void>;
}

export async function startFtpServer(): Promise<TestFtpServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ftp-test-root-"));
  const transfers: WireTransfer[] = [];

  class RecordingFileSystem extends FileSystem {
    write(fileName: string, options?: { append?: boolean; start?: any }) {
      transfers.push({ command: options?.append ? "APPE" : "STOR", name: fileName, type: this.connection.transferType });
      return super.write(fileName, options);
    }
    read(fileName: string, options?: { start?: any }) {
      transfers.push({ command: "RETR", name: fileName, type: this.connection.transferType });
      return super.read(fileName, options);
    }
  }

  const require = createRequire(import.meta.url);
  const bunyan = require("bunyan");
  const server = new FtpSrv({
    url: "ftp://127.0.0.1:0",
    pasv_url: "127.0.0.1",
    anonymous: false,
    log: bunyan.createLogger({ name: "ftp-srv-test", level: bunyan.FATAL + 1 }),
  } as any);
  server.on("login", ({ connection, username, password }: any, resolve: any, reject: any) => {
    if (username === TEST_USER && password === TEST_PASSWORD) {
      resolve({ fs: new RecordingFileSystem(connection, { root, cwd: "/" }) });
    } else {
      reject(new Error("bad credentials"));
    }
  });
  await server.listen();
  const port = (server as any).server.address().port as number;

  return {
    port,
    root,
    transfers,
    async close() {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface McpHandle {
  client: Client;
  logDir: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, any>;
}

export function resultText(r: ToolResult): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

export async function startMcp(extraEnv: Record<string, string> = {}): Promise<McpHandle> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ftp-test-log-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("FTP_")) env[k] = v;
  }
  env.FTP_LOG_DIR = logDir;
  Object.assign(env, extraEnv);
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_JS], env, stderr: "ignore" });
  const client = new Client({ name: "mcp-ftp-test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    logDir,
    async call(name, args) {
      return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
    },
    async close() {
      await client.close();
      fs.rmSync(logDir, { recursive: true, force: true });
    },
  };
}

/** Connection arguments for a tool call against the loopback FTP server. */
export function ftpArgs(srv: TestFtpServer): Record<string, unknown> {
  return { host: "127.0.0.1", port: srv.port, protocol: "ftp", user: TEST_USER, password: TEST_PASSWORD };
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(p: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Write `bytes` of random data to `p` in 1 MiB pieces; returns the SHA-256. */
export function writeRandomFile(p: string, bytes: number): string {
  const h = createHash("sha256");
  const fd = fs.openSync(p, "w");
  try {
    for (let left = bytes; left > 0; ) {
      const piece = randomBytes(Math.min(left, 1 << 20));
      h.update(piece);
      fs.writeSync(fd, piece);
      left -= piece.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export function scratchDir(prefix = "mcp-ftp-test-local-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
