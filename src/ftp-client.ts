import { Client, FileInfo, FileType } from "basic-ftp";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { isUtf8 } from "buffer";
import { createHash, randomUUID } from "crypto";
import { PassThrough, Readable } from "stream";
import { pipeline } from "stream/promises";
import { CrlfToLf, LfToCrlf } from "./text-mode.js";
import {
  LocalTransferResult,
  TransferMode,
  commitDownload,
  discardTemp,
  prepareDownloadTarget,
  requireLocalSource,
} from "./transfer.js";

// Define FTP config interface
export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}

export type FileEncoding = "utf8" | "base64";

/**
 * Run `operation` with the data type set for `mode`, and put the connection
 * back to TYPE I afterwards, even if the operation fails.
 *
 * basic-ftp sends `TYPE I` once at login and assumes it stays that way, so an
 * ASCII transfer that left TYPE A behind would silently corrupt the next
 * binary transfer on the same connection. This server currently opens a fresh
 * connection per operation (see `withConnection`), so nothing reuses one
 * today; the restore keeps that true if it ever changes.
 */
export async function withTransferType<T>(client: Client, mode: TransferMode, operation: () => Promise<T>): Promise<T> {
  if (mode !== "ascii") return operation();
  await client.send("TYPE A");
  try {
    return await operation();
  } finally {
    try {
      await client.sendIgnoringError("TYPE I");
    } catch {
      /* the connection is already gone, so there is nothing left to restore */
    }
  }
}

interface StreamCounts {
  localBytes: number;
  wireBytes: number;
}

/**
 * Wrap a source of local bytes for sending: hash and count what is read (the
 * LOCAL bytes) and, for ASCII mode, convert LF to CR LF on the way out.
 */
async function* toWire(source: AsyncIterable<Buffer> | Iterable<Buffer>, mode: TransferMode, hash: ReturnType<typeof createHash>, counts: StreamCounts) {
  const encoder = mode === "ascii" ? new LfToCrlf() : null;
  for await (const chunk of source) {
    hash.update(chunk);
    counts.localBytes += chunk.length;
    const out = encoder ? encoder.convert(chunk) : chunk;
    counts.wireBytes += out.length;
    if (out.length > 0) yield out;
  }
}

function readLocalFile(file: string): AsyncIterable<Buffer> {
  return fs.createReadStream(file, { highWaterMark: 256 * 1024 }) as unknown as AsyncIterable<Buffer>;
}

/**
 * Custom directory listing parser for OpenVMS TCP/IP Services FTP servers.
 * OpenVMS format:
 * FILENAME.EXT;VER   USED/ALLOC   DATE TIME   [UIC]   (PROT)
 * Long filenames may place the size/date on the following line.
 */
function parseVmsList(rawListing: string): FileInfo[] {
  const lines = rawListing.split(/\r?\n/);
  const files: FileInfo[] = [];
  let pendingName: string | null = null;

  const fileRegex = /^([A-Za-z0-9_$.-]+;[0-9]+)\s+(\d+)\/(\d+)\s+(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/;
  const nameOnlyRegex = /^([A-Za-z0-9_$.-]+;[0-9]+)\s*$/;
  const continuationRegex = /^\s+(\d+)\/(\d+)\s+(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line || line.startsWith("Directory ") || line.startsWith("Total of ")) continue;

    if (pendingName) {
      const contMatch = line.match(continuationRegex);
      if (contMatch) {
        const usedBlocks = parseInt(contMatch[1], 10);
        const dateStr = contMatch[3];
        const info = new FileInfo(pendingName);
        info.size = usedBlocks * 512;
        info.rawModifiedAt = dateStr;
        const parsedDate = new Date(dateStr);
        if (!isNaN(parsedDate.getTime())) {
          info.modifiedAt = parsedDate;
        }
        info.type = pendingName.toUpperCase().includes(".DIR;") ? FileType.Directory : FileType.File;
        files.push(info);
        pendingName = null;
        continue;
      } else {
        const info = new FileInfo(pendingName);
        info.type = pendingName.toUpperCase().includes(".DIR;") ? FileType.Directory : FileType.File;
        files.push(info);
        pendingName = null;
      }
    }

    const match = line.match(fileRegex);
    if (match) {
      const name = match[1];
      const usedBlocks = parseInt(match[2], 10);
      const dateStr = match[4];
      const info = new FileInfo(name);
      info.size = usedBlocks * 512;
      info.rawModifiedAt = dateStr;
      const parsedDate = new Date(dateStr);
      if (!isNaN(parsedDate.getTime())) {
        info.modifiedAt = parsedDate;
      }
      info.type = name.toUpperCase().includes(".DIR;") ? FileType.Directory : FileType.File;
      files.push(info);
    } else {
      const nameMatch = line.match(nameOnlyRegex);
      if (nameMatch) {
        pendingName = nameMatch[1];
      }
    }
  }

  if (pendingName) {
    const info = new FileInfo(pendingName);
    info.type = pendingName.toUpperCase().includes(".DIR;") ? FileType.Directory : FileType.File;
    files.push(info);
  }

  return files;
}

// Create FTP client wrapper
export class FtpClient {
  private config: FtpConfig;
  private tempDir: string;

  constructor(config: FtpConfig) {
    this.config = config;
    this.tempDir = path.join(os.tmpdir(), "mcp-ftp-temp");

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  // Runs an operation on a fresh connection, guaranteeing disconnect even on error
  private async withConnection<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client();
    client.ftp.verbose = false; // Set to true for debugging
    const defaultParseList = client.parseList.bind(client);
    client.parseList = (rawList: string) => {
      try {
        return defaultParseList(rawList);
      } catch (err) {
        const vms = parseVmsList(rawList);
        if (vms.length > 0 || rawList.includes("Total of 0 files")) {
          return vms;
        }
        throw err;
      }
    };

    try {
      await client.access({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        secure: this.config.secure
      });
      return await operation(client);
    } finally {
      client.close();
    }
  }

  async listDirectory(remotePath: string): Promise<Array<{name: string, type: string, size: number, modifiedDate: string}>> {
    try {
      const targetPath = (remotePath === "." || remotePath === "./") ? "" : remotePath;
      const list = await this.withConnection((client) => client.list(targetPath));

      return list.map(item => ({
        name: item.name,
        type: item.type === 1 ? "file" : item.type === 2 ? "directory" : "other",
        size: item.size,
        modifiedDate: item.modifiedAt ? item.modifiedAt.toISOString() : item.rawModifiedAt || ""
      }));
    } catch (error) {
      console.error("List directory error:", error);
      throw new Error(`Failed to list directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch `remotePath` into the local file `tempPath` (which must not exist),
   * converting CR LF to LF in ASCII mode. Counts, and hashes, the bytes as
   * written locally.
   */
  private async receiveToFile(remotePath: string, tempPath: string, mode: TransferMode): Promise<LocalTransferResult> {
    const hash = createHash("sha256");
    const counts: StreamCounts = { localBytes: 0, wireBytes: 0 };
    const decoder = mode === "ascii" ? new CrlfToLf() : null;

    // basic-ftp pipes the data socket into `head` and ends it; the pipeline below
    // carries it on through the (optional) converter into the file.
    const head = new PassThrough();
    const written = pipeline(
      head,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          counts.wireBytes += chunk.length;
          const out = decoder ? decoder.convert(chunk) : chunk;
          if (out.length > 0) {
            hash.update(out);
            counts.localBytes += out.length;
            yield out;
          }
        }
        const tail = decoder ? decoder.flush() : null;
        if (tail && tail.length > 0) {
          hash.update(tail);
          counts.localBytes += tail.length;
          yield tail;
        }
      },
      fs.createWriteStream(tempPath, { flags: "wx" })
    );
    written.catch(() => {}); // observed below; this keeps an early failure from being "unhandled"

    try {
      await this.withConnection((client) => withTransferType(client, mode, () => client.downloadTo(head, remotePath)));
      await written;
    } catch (error) {
      head.destroy();
      await written.catch(() => {});
      throw error;
    }
    return { localBytes: counts.localBytes, wireBytes: counts.wireBytes, sha256: hash.digest("hex"), transferMode: mode };
  }

  /** Send `source` with STOR (replace) or APPE (append), converting LF to CR LF in ASCII mode. */
  private async sendFromSource(command: "STOR" | "APPE", remotePath: string, source: AsyncIterable<Buffer> | Iterable<Buffer>, mode: TransferMode): Promise<LocalTransferResult> {
    const hash = createHash("sha256");
    const counts: StreamCounts = { localBytes: 0, wireBytes: 0 };
    const wire = Readable.from(toWire(source, mode, hash, counts), { objectMode: false });
    try {
      await this.withConnection((client) =>
        withTransferType(client, mode, () =>
          command === "STOR" ? client.uploadFrom(wire, remotePath) : client.appendFrom(wire, remotePath)
        )
      );
    } finally {
      wire.destroy();
    }
    return { localBytes: counts.localBytes, wireBytes: counts.wireBytes, sha256: hash.digest("hex"), transferMode: mode };
  }

  async downloadFile(remotePath: string, mode: TransferMode = "binary"): Promise<{content: string, encoding: FileEncoding}> {
    const tempFilePath = path.join(this.tempDir, `download-${randomUUID()}-${path.basename(remotePath)}`);
    try {
      await this.receiveToFile(remotePath, tempFilePath, mode);

      // Read as raw bytes; only decode as utf8 when the content actually is valid utf8,
      // otherwise fall back to base64 so binary files survive the round trip
      const buffer = fs.readFileSync(tempFilePath);
      if (isUtf8(buffer)) {
        return { content: buffer.toString("utf8"), encoding: "utf8" };
      }
      return { content: buffer.toString("base64"), encoding: "base64" };
    } catch (error) {
      console.error("Download file error:", error);
      throw new Error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
  }

  /** Stream `remotePath` to a local file. Refuses to replace an existing file unless `overwrite`; creates no directories. */
  async downloadToLocal(remotePath: string, localPath: string, mode: TransferMode = "binary", overwrite = false): Promise<LocalTransferResult> {
    try {
      const dest = prepareDownloadTarget(localPath, overwrite);
      try {
        const result = await this.receiveToFile(remotePath, dest.temp, mode);
        commitDownload(dest, overwrite);
        return { ...result, localPath: dest.target };
      } catch (error) {
        discardTemp(dest.temp);
        throw error;
      }
    } catch (error) {
      console.error("Download file error:", error);
      throw new Error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async uploadFile(remotePath: string, content: string, encoding: FileEncoding = "utf8", mode: TransferMode = "binary"): Promise<LocalTransferResult> {
    try {
      return await this.sendFromSource("STOR", remotePath, [Buffer.from(content, encoding)], mode);
    } catch (error) {
      console.error("Upload file error:", error);
      throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stream a local file to `remotePath` with no temporary copy and no size limit. */
  async uploadLocalFile(remotePath: string, localPath: string, mode: TransferMode = "binary"): Promise<LocalTransferResult> {
    try {
      const source = requireLocalSource(localPath);
      return { ...(await this.sendFromSource("STOR", remotePath, readLocalFile(source), mode)), localPath: source };
    } catch (error) {
      console.error("Upload file error:", error);
      throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.withConnection((client) => client.ensureDir(remotePath));
      return true;
    } catch (error) {
      console.error("Create directory error:", error);
      throw new Error(`Failed to create directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteFile(remotePath: string): Promise<boolean> {
    try {
      await this.withConnection(async (client) => {
        try {
          await client.remove(remotePath);
        } catch (err: any) {
          if (err?.message?.includes("version number") && !remotePath.includes(";")) {
            await client.remove(remotePath + ";0");
          } else {
            throw err;
          }
        }
      });
      return true;
    } catch (error) {
      console.error("Delete file error:", error);
      throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.withConnection((client) => client.removeDir(remotePath));
      return true;
    } catch (error) {
      console.error("Delete directory error:", error);
      throw new Error(`Failed to delete directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async appendFile(remotePath: string, content: string, encoding: FileEncoding = "utf8", mode: TransferMode = "binary"): Promise<LocalTransferResult> {
    try {
      return await this.sendFromSource("APPE", remotePath, [Buffer.from(content, encoding)], mode);
    } catch (error) {
      console.error("Append file error:", error);
      throw new Error(`Failed to append to file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stream a local file onto the end of `remotePath`. */
  async appendLocalFile(remotePath: string, localPath: string, mode: TransferMode = "binary"): Promise<LocalTransferResult> {
    try {
      const source = requireLocalSource(localPath);
      return { ...(await this.sendFromSource("APPE", remotePath, readLocalFile(source), mode)), localPath: source };
    } catch (error) {
      console.error("Append file error:", error);
      throw new Error(`Failed to append to file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async rename(fromPath: string, toPath: string): Promise<boolean> {
    try {
      await this.withConnection((client) => client.rename(fromPath, toPath));
      return true;
    } catch (error) {
      console.error("Rename error:", error);
      throw new Error(`Failed to rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
