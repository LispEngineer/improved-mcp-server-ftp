/**
 * Transfer logging utilities for FTP and SFTP MCP operations.
 * Provides persistent disk logging of file transfers, modifications, and deletions
 * with ISO-8601 timestamps, file sizes, SHA-256 integrity hashes, and transfer metrics.
 * Modeled after the session logging mechanism in chuk-mcp-telnet-client.
 *
 * Contributor: Douglas P. Fields, Jr. (symbolics@lisp.engineer)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";

export interface TransferLogEntry {
  operation: "UPLOAD" | "DOWNLOAD" | "APPEND" | "EDIT" | "DELETE";
  host: string;
  port: number;
  protocol: string;
  user: string;
  remotePath: string;
  sizeBytes?: number;
  remoteModifiedDate?: string;
  encoding?: string;
  content?: string | Buffer;
  sha256?: string;
  /** "binary" or "ascii"; for FTP only. Logged as `Mode`. */
  transferMode?: string;
  /**
   * Set for localPath transfers. `sizeBytes` and `sha256` are then those of this
   * LOCAL file (in ASCII mode the wire and remote sizes differ), and no file
   * content is ever logged.
   */
  localPath?: string;
  /** Bytes on the wire when they differ from `sizeBytes` (ASCII mode). */
  wireBytes?: number;
  durationMs?: number;
  status: "SUCCESS" | "FAILED";
  error?: string;
  details?: Record<string, unknown>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return (Number.isInteger(bytes) ? bytes : bytes.toFixed(2)) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

export class TransferLogger {
  private logDir: string;
  private logFilePath: string;

  constructor(customLogDir?: string) {
    this.logDir = this.resolveLogDir(customLogDir);
    this.logFilePath = path.join(this.logDir, "ftp_transfers.log");
    this.ensureLogDir();
  }

  private resolveLogDir(custom?: string): string {
    if (custom && custom.trim() !== "") {
      return path.resolve(custom.trim());
    }

    // Check FTP_LOG_DIR first, then fall back to TELNET_LOG_DIR / SERIAL_LOG_DIR
    const envDir =
      process.env.FTP_LOG_DIR ||
      process.env.TELNET_LOG_DIR ||
      process.env.SERIAL_LOG_DIR;
    if (envDir && envDir.trim() !== "") {
      return path.resolve(envDir.trim());
    }

    // Smart fallback: check if current working directory has a logs/ folder
    const cwdLogs = path.join(process.cwd(), "logs");
    if (fs.existsSync(cwdLogs) && fs.statSync(cwdLogs).isDirectory()) {
      return cwdLogs;
    }

    // Default global fallback
    return path.join(os.homedir(), ".mcp-ftp-logs");
  }

  private ensureLogDir(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (err) {
      console.error(`[TransferLogger] Could not create log directory '${this.logDir}':`, err);
    }
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  public getLogDir(): string {
    return this.logDir;
  }

  public logTransfer(entry: TransferLogEntry): string {
    this.ensureLogDir();
    const timestamp = new Date().toISOString();

    // Compute SHA-256 if content is provided and hash is not pre-computed
    let hash = entry.sha256;
    if (!hash && entry.content !== undefined) {
      try {
        const buf =
          typeof entry.content === "string"
            ? Buffer.from(entry.content, entry.encoding === "base64" ? "base64" : "utf8")
            : entry.content;
        hash = createHash("sha256").update(buf).digest("hex");
      } catch {
        hash = undefined;
      }
    }

    const sizeStr =
      entry.sizeBytes !== undefined
        ? `${formatBytes(entry.sizeBytes)} (${entry.sizeBytes} bytes)`
        : "N/A";
    const durationStr =
      entry.durationMs !== undefined ? `${entry.durationMs} ms` : "N/A";

    let speedStr = "";
    if (
      entry.sizeBytes !== undefined &&
      entry.durationMs !== undefined &&
      entry.durationMs > 0
    ) {
      const bytesPerSec = (entry.sizeBytes / entry.durationMs) * 1000;
      speedStr = ` (${formatBytes(bytesPerSec)}/s)`;
    }

    const lines = [
      "=".repeat(80),
      `[${timestamp}] FTP TRANSFER: ${entry.operation} - ${entry.status}`,
      `Target       : ${entry.host}:${entry.port} (${entry.user})`,
      `Protocol     : ${entry.protocol.toUpperCase()}`,
      `Remote Path  : ${entry.remotePath}`,
      `Size         : ${sizeStr}`,
    ];

    if (entry.remoteModifiedDate) {
      lines.push(`Remote Date  : ${entry.remoteModifiedDate}`);
    }
    if (entry.encoding) {
      lines.push(`Encoding     : ${entry.encoding}`);
    }
    if (entry.transferMode) {
      lines.push(`Mode         : ${entry.transferMode.toUpperCase()}${entry.transferMode === "ascii" ? " (TYPE A: CR LF on the wire)" : ""}`);
    }
    if (entry.localPath) {
      lines.push(`Local Path   : ${entry.localPath}`);
      lines.push(`Local Note   : Size and SHA-256 are of this local file`);
    }
    if (entry.wireBytes !== undefined && entry.wireBytes !== entry.sizeBytes) {
      lines.push(`Wire Bytes   : ${entry.wireBytes}`);
    }
    if (hash) {
      lines.push(`SHA-256      : ${hash}`);
    }
    lines.push(`Duration     : ${durationStr}${speedStr}`);

    if (entry.error) {
      lines.push(`Error        : ${entry.error}`);
    }
    if (entry.details && Object.keys(entry.details).length > 0) {
      lines.push(`Details      : ${JSON.stringify(entry.details)}`);
    }
    lines.push("=".repeat(80));
    lines.push("");

    const block = lines.join("\n") + "\n";
    try {
      fs.appendFileSync(this.logFilePath, block, "utf8");
    } catch (err) {
      console.error(`[TransferLogger] Error writing to '${this.logFilePath}':`, err);
    }

    return this.logFilePath;
  }
}
