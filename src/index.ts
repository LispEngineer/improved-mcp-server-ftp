#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FtpClient, FtpConfig } from "./ftp-client.js";
import { SftpClient, SftpConfig } from "./sftp-client.js";
import { decrypt } from "./crypto.js";
import { ConnectionType } from "./connection-type.js";
import { loadEncryptionKey } from "./keychain.js";
import { TransferLogger, formatBytes } from "./logger.js";
import { SFTP_ASCII_MESSAGE, TransferMode, resolveLocalPath } from "./transfer.js";

function resolveSecure(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no" || v === undefined) return false;
  throw new Error(`Invalid value for FTP_SECURE: "${raw}". Expected one of: true/false, 1/0, yes/no.`);
}

function resolveProtocol(raw: string | undefined): ConnectionType {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return ConnectionType.FTP;
  if (v === ConnectionType.FTP) return ConnectionType.FTP;
  if (v === ConnectionType.SFTP) return ConnectionType.SFTP;
  throw new Error(
    `Invalid value for FTP_PROTOCOL: "${raw}". Expected one of: ${ConnectionType.FTP}, ${ConnectionType.SFTP}.`
  );
}

// Global default configuration from environment
let defaultProtocol = ConnectionType.FTP;
let defaultHost = "localhost";
let defaultUser = "anonymous";
let defaultPassword = "";
let defaultFtpPort = 21;
let defaultSftpPort = 22;
let defaultSecure = false;
let defaultPassphrase = "";
let defaultPrivateKeyPath = "";

// Common connection parameters schema for all tools
const connectionParamsSchema = {
  host: z.string().optional().describe("Server hostname or IP address (falls back to FTP_HOST env var)"),
  port: z.number().int().optional().describe("Server port (default: 21 for FTP, 22 for SFTP, or FTP_PORT env var)"),
  protocol: z.enum(["ftp", "sftp"]).optional().describe("Protocol: 'ftp' or 'sftp' (default: 'ftp', or FTP_PROTOCOL env var)"),
  user: z.string().optional().describe("Username for authentication (falls back to FTP_USER env var)"),
  password: z.string().optional().describe("Password for authentication (falls back to FTP_PASSWORD env var)"),
  secure: z.boolean().optional().describe("Enable FTPS / TLS (default: false, or FTP_SECURE env var)"),
  log_dir: z.string().optional().describe("Directory for transfer log files (defaults to FTP_LOG_DIR, TELNET_LOG_DIR, or ./logs)"),
};

interface ConnectionArgs {
  host?: string;
  port?: number;
  protocol?: "ftp" | "sftp";
  user?: string;
  password?: string;
  secure?: boolean;
  log_dir?: string;
}

type AnyFtpClient = FtpClient | SftpClient;

// Shared parameters and checks for the tools that move file bytes (download-file, upload-file, append-file)
const transferModeSchema = z
  .enum(["binary", "ascii"])
  .optional()
  .describe(
    "FTP data type (default: binary). 'binary' is byte-exact (archives, images, savesets). 'ascii' sends TYPE A: local LF becomes CR LF on upload and CR LF becomes LF on download, which text needs on servers that store text as records (OpenVMS). Never guessed from the file name. Not available for SFTP."
  );

function localPathSchema(what: string) {
  return z.string().optional().describe(`${what}. Absolute, or relative to the MCP server's working directory; a leading ~ is expanded.`);
}

/** upload-file / append-file: exactly one source of bytes. */
function sourceProblem(content: string | undefined, localPath: string | undefined, encoding: string | undefined): string | null {
  if ((content === undefined) === (localPath === undefined)) {
    return content === undefined
      ? "Give exactly one of content and localPath; neither was given."
      : "Give exactly one of content and localPath; both were given.";
  }
  if (localPath !== undefined && encoding !== undefined) {
    return "encoding applies only to content; a localPath file is sent as its raw bytes.";
  }
  return null;
}

function modeProblem(protocol: ConnectionType, mode: TransferMode): string | null {
  return protocol === ConnectionType.SFTP && mode === "ascii" ? SFTP_ASCII_MESSAGE : null;
}

/** For the transfer log when a transfer failed before reporting the path it used. */
function displayLocalPath(localPath: string): string {
  try {
    return resolveLocalPath(localPath);
  } catch {
    return localPath;
  }
}

interface ResolvedConnection {
  client: AnyFtpClient;
  host: string;
  port: number;
  protocol: ConnectionType;
  user: string;
  logger: TransferLogger;
}

function resolveConnection(conn: ConnectionArgs): ResolvedConnection {
  const protocol = conn.protocol ? resolveProtocol(conn.protocol) : defaultProtocol;
  const host = conn.host || defaultHost;
  const user = conn.user !== undefined ? decrypt(conn.user) : defaultUser;
  const password = conn.password !== undefined ? decrypt(conn.password) : defaultPassword;
  const port = conn.port ?? (protocol === ConnectionType.SFTP ? defaultSftpPort : defaultFtpPort);
  const logger = new TransferLogger(conn.log_dir);

  let client: AnyFtpClient;
  if (protocol === ConnectionType.SFTP) {
    const sftpConfig: SftpConfig = {
      host,
      port,
      user,
      password,
      passphrase: defaultPassphrase,
      privateKeyPath: defaultPrivateKeyPath,
    };
    client = new SftpClient(sftpConfig);
  } else {
    const ftpConfig: FtpConfig = {
      host,
      port,
      user,
      password,
      secure: conn.secure !== undefined ? conn.secure : defaultSecure,
    };
    client = new FtpClient(ftpConfig);
  }

  return { client, host, port, protocol, user, logger };
}

// Create server instance
const server = new McpServer({
  name: "mcp-server-ftp",
  version: "1.5.0",
});

// The MCP SDK dispatches tool calls concurrently, but concurrent FTP operations
// race each other (read-modify-write edits can silently lose updates, and many
// FTP servers cap simultaneous connections). Queue every tool call so each
// operation runs to completion before the next starts. Note this makes
// operations atomic but does not guarantee ordering between calls issued in
// parallel — clients needing ordering must await each result before the next call.
let operationQueue: Promise<unknown> = Promise.resolve();
function serialized<Args extends unknown[], R>(handler: (...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
  return (...args: Args) => {
    const run = () => handler(...args);
    const result = operationQueue.then(run, run);
    operationQueue = result.catch(() => {});
    return result;
  };
}

function errorResult(prefix: string, error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${prefix}: ${error instanceof Error ? error.message : String(error)}`
      }
    ]
  };
}

// Register list-directory tool
server.registerTool(
  "list-directory",
  {
    title: "List Directory",
    description: "List contents of an FTP/SFTP directory. Optionally specify host, port, protocol, user, password, and log_dir per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory on the FTP server"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    const { client } = resolveConnection(conn);
    try {
      const listing = await client.listDirectory(remotePath);

      // Format the output
      const formatted = listing.map((item) =>
        `${item.type === "directory" ? "[DIR]" : "[FILE]"} ${item.name} ${item.type === "file" ? `(${formatBytes(item.size)})` : ""} - ${item.modifiedDate}`
      ).join("\n");

      const directoryCount = listing.filter(i => i.type === "directory").length;
      const fileCount = listing.filter(i => i.type === "file").length;
      const summary = `Total: ${listing.length} items (${directoryCount} directories, ${fileCount} files)`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Directory listing for: ${remotePath}\n\n${formatted}\n\n${summary}`
          }
        ],
        structuredContent: {
          path: remotePath,
          entries: listing,
          totalCount: listing.length,
          directoryCount,
          fileCount,
        },
      };
    } catch (error) {
      return errorResult("Error listing directory", error);
    }
  })
);

// Register download-file tool
server.registerTool(
  "download-file",
  {
    title: "Download File",
    description: "Download a file from the FTP/SFTP server. Without localPath, text files are returned as-is and binary files base64-encoded, through the conversation. With localPath the file is streamed to that local file instead (any size) and only metadata is returned: bytes, SHA-256, duration, mode, never the content. localPath is absolute or relative to this server's working directory (a leading ~ is expanded); an existing file is refused unless overwrite is true, and no directories are created. transferMode \"ascii\" (FTP only) converts CR LF to LF and suits text on servers that keep text as records, such as OpenVMS; the default \"binary\" is byte-exact and right for archives and images. Transferred file metadata is permanently logged to ftp_transfers.log.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
      localPath: localPathSchema("Local file to stream the download into instead of returning its content"),
      overwrite: z.boolean().optional().describe("With localPath: replace the local file if it already exists (default: false, which refuses)"),
      transferMode: transferModeSchema,
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, localPath, overwrite, transferMode, ...conn }) => {
    const { client, host, port, protocol, user, logger } = resolveConnection(conn);
    const t0 = Date.now();
    const mode: TransferMode = transferMode ?? "binary";
    const problem =
      (overwrite !== undefined && localPath === undefined ? "overwrite only applies together with localPath" : null) ??
      modeProblem(protocol, mode);
    if (problem) return errorResult("Error downloading file", new Error(problem));
    try {
      if (localPath !== undefined) {
        const r = await client.downloadToLocal(remotePath, localPath, mode, overwrite ?? false);
        const durationMs = Date.now() - t0;
        const logFile = logger.logTransfer({
          operation: "DOWNLOAD",
          host,
          port,
          protocol,
          user,
          remotePath,
          sizeBytes: r.localBytes,
          sha256: r.sha256,
          localPath: r.localPath,
          transferMode: mode,
          wireBytes: r.wireBytes,
          durationMs,
          status: "SUCCESS",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Downloaded ${remotePath} to ${r.localPath} (${formatBytes(r.localBytes)}, ${mode}, SHA-256 ${r.sha256}, ${durationMs} ms, logged to ${logFile})`
            }
          ],
          structuredContent: {
            remotePath,
            localPath: r.localPath,
            bytes: r.localBytes,
            sha256: r.sha256,
            transferMode: mode,
            ...(mode === "ascii" ? { wireBytes: r.wireBytes } : {}),
            durationMs,
            logFile,
          },
        };
      }

      const { content, encoding } = await client.downloadFile(remotePath, mode);
      const durationMs = Date.now() - t0;
      const sizeBytes = Buffer.byteLength(content, encoding);

      const logFile = logger.logTransfer({
        operation: "DOWNLOAD",
        host,
        port,
        protocol,
        user,
        remotePath,
        sizeBytes,
        encoding,
        content,
        transferMode: mode,
        durationMs,
        status: "SUCCESS",
      });

      const header = encoding === "base64"
        ? `File content of ${remotePath} (binary, base64-encoded, ${formatBytes(sizeBytes)}):`
        : `File content of ${remotePath} (${formatBytes(sizeBytes)}):`;

      return {
        content: [
          {
            type: "text" as const,
            text: `${header}\n\n${content}`
          }
        ],
        structuredContent: { remotePath, content, encoding, sizeBytes, transferMode: mode, durationMs, logFile },
      };
    } catch (error) {
      const durationMs = Date.now() - t0;
      logger.logTransfer({
        operation: "DOWNLOAD",
        host,
        port,
        protocol,
        user,
        remotePath,
        localPath: localPath !== undefined ? displayLocalPath(localPath) : undefined,
        transferMode: mode,
        durationMs,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult("Error downloading file", error);
    }
  })
);

// Register upload-file tool
server.registerTool(
  "upload-file",
  {
    title: "Upload File",
    description: "Upload a file to the FTP/SFTP server. Give exactly one of content (a string; pass encoding \"base64\" for binary content, but everything then passes through the conversation) or localPath (a local file streamed from disk: any size, no temporary copy, only metadata returned). localPath is absolute or relative to this server's working directory (a leading ~ is expanded). transferMode \"ascii\" (FTP only) sends TYPE A and converts local LF to CR LF, so text arrives with proper line ends on servers that keep text as records: a text file sent in the default binary mode to OpenVMS arrives as fixed 512-byte records that DCL cannot run. Use \"binary\" (the default, byte-exact) for archives, images and savesets. The mode is never guessed from the file name. Transferred file metadata is permanently logged to ftp_transfers.log.",
    inputSchema: {
      remotePath: z.string().describe("Destination path on the FTP server"),
      content: z.string().optional().describe("Content to upload to the file (give this or localPath, not both)"),
      localPath: localPathSchema("Local file to stream to the server (give this or content, not both)"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding of the provided content (default: utf8); not for use with localPath"),
      transferMode: transferModeSchema,
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, content, localPath, encoding, transferMode, ...conn }) => {
    const { client, host, port, protocol, user, logger } = resolveConnection(conn);
    const t0 = Date.now();
    const enc = encoding ?? "utf8";
    const mode: TransferMode = transferMode ?? "binary";
    const problem = sourceProblem(content, localPath, encoding) ?? modeProblem(protocol, mode);
    if (problem) return errorResult("Error uploading file", new Error(problem));
    try {
      const r = localPath !== undefined
        ? await client.uploadLocalFile(remotePath, localPath, mode)
        : await client.uploadFile(remotePath, content!, enc, mode);
      const durationMs = Date.now() - t0;

      const logFile = logger.logTransfer({
        operation: "UPLOAD",
        host,
        port,
        protocol,
        user,
        remotePath,
        sizeBytes: r.localBytes,
        sha256: r.sha256,
        encoding: localPath === undefined ? enc : undefined,
        localPath: r.localPath,
        transferMode: mode,
        wireBytes: r.wireBytes,
        durationMs,
        status: "SUCCESS",
      });

      const from = r.localPath ? ` from ${r.localPath}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `File successfully uploaded to ${remotePath}${from} (${formatBytes(r.localBytes)}, ${mode}, SHA-256 ${r.sha256}, logged to ${logFile})`
          }
        ],
        structuredContent: {
          remotePath,
          bytesWritten: r.localBytes,
          sha256: r.sha256,
          transferMode: mode,
          ...(r.localPath ? { localPath: r.localPath } : {}),
          ...(mode === "ascii" ? { wireBytes: r.wireBytes } : {}),
          durationMs,
          logFile,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - t0;
      logger.logTransfer({
        operation: "UPLOAD",
        host,
        port,
        protocol,
        user,
        remotePath,
        ...(localPath !== undefined
          ? { localPath: displayLocalPath(localPath) }
          : { sizeBytes: Buffer.byteLength(content!, enc), encoding: enc, content }),
        transferMode: mode,
        durationMs,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult("Error uploading file", error);
    }
  })
);

// Register create-directory tool
server.registerTool(
  "create-directory",
  {
    title: "Create Directory",
    description: "Create a new directory on the FTP/SFTP server. Optionally specify host, port, protocol, user, password, and log_dir per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory to create"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    const { client } = resolveConnection(conn);
    try {
      await client.createDirectory(remotePath);

      return {
        content: [
          {
            type: "text" as const,
            text: `Directory successfully created at ${remotePath}`
          }
        ],
        structuredContent: { remotePath, created: true },
      };
    } catch (error) {
      return errorResult("Error creating directory", error);
    }
  })
);

// Register delete-file tool
server.registerTool(
  "delete-file",
  {
    title: "Delete File",
    description: "Delete a file from the FTP/SFTP server. Deletions are logged with timestamps to ftp_transfers.log.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file to delete"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    const { client, host, port, protocol, user, logger } = resolveConnection(conn);
    const t0 = Date.now();
    try {
      await client.deleteFile(remotePath);
      const durationMs = Date.now() - t0;

      const logFile = logger.logTransfer({
        operation: "DELETE",
        host,
        port,
        protocol,
        user,
        remotePath,
        durationMs,
        status: "SUCCESS",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `File successfully deleted from ${remotePath} (logged to ${logFile})`
          }
        ],
        structuredContent: { remotePath, deleted: true, durationMs, logFile },
      };
    } catch (error) {
      const durationMs = Date.now() - t0;
      logger.logTransfer({
        operation: "DELETE",
        host,
        port,
        protocol,
        user,
        remotePath,
        durationMs,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult("Error deleting file", error);
    }
  })
);

// Register delete-directory tool
server.registerTool(
  "delete-directory",
  {
    title: "Delete Directory",
    description: "Delete a directory from the FTP/SFTP server. Optionally specify host, port, protocol, user, password, and log_dir per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory to delete"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    const { client } = resolveConnection(conn);
    try {
      await client.deleteDirectory(remotePath);

      return {
        content: [
          {
            type: "text" as const,
            text: `Directory successfully deleted from ${remotePath}`
          }
        ],
        structuredContent: { remotePath, deleted: true },
      };
    } catch (error) {
      return errorResult("Error deleting directory", error);
    }
  })
);

// Register rename-file tool
server.registerTool(
  "rename-file",
  {
    title: "Rename / Move",
    description: "Rename or move a file or directory on the FTP/SFTP server. Optionally specify host, port, protocol, user, password, and log_dir per transaction.",
    inputSchema: {
      fromPath: z.string().describe("Current path of the file or directory"),
      toPath: z.string().describe("New path for the file or directory"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ fromPath, toPath, ...conn }) => {
    const { client } = resolveConnection(conn);
    try {
      await client.rename(fromPath, toPath);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully renamed ${fromPath} to ${toPath}`
          }
        ],
        structuredContent: { fromPath, toPath, renamed: true },
      };
    } catch (error) {
      return errorResult("Error renaming", error);
    }
  })
);

// Register edit-file tool
server.registerTool(
  "edit-file",
  {
    title: "Edit File",
    description: "Edit a text file on the FTP/SFTP server by replacing an exact string, without re-uploading the whole file content. oldText must match exactly (including whitespace) and be unique in the file unless replaceAll is set. File edits are logged to ftp_transfers.log.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
      oldText: z.string().describe("Exact text to find in the file"),
      newText: z.string().describe("Text to replace it with"),
      replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring oldText to be unique (default: false)"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ remotePath, oldText, newText, replaceAll, ...conn }) => {
    const { client, host, port, protocol, user, logger } = resolveConnection(conn);
    const t0 = Date.now();
    try {
      if (oldText === "") {
        return errorResult("Error editing file", new Error("oldText must not be empty"));
      }
      if (oldText === newText) {
        return errorResult("Error editing file", new Error("oldText and newText are identical; nothing to change"));
      }

      const { content, encoding } = await client.downloadFile(remotePath);
      if (encoding === "base64") {
        return errorResult(
          "Error editing file",
          new Error(`${remotePath} is a binary file and cannot be text-edited. Use download-file/upload-file with base64 encoding instead.`)
        );
      }

      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) {
        return errorResult(
          "Error editing file",
          new Error(`oldText not found in ${remotePath}. It must match the file content exactly, including whitespace and line breaks.`)
        );
      }
      if (occurrences > 1 && !replaceAll) {
        return errorResult(
          "Error editing file",
          new Error(`oldText matches ${occurrences} places in ${remotePath}. Include more surrounding context to make it unique, or set replaceAll to true.`)
        );
      }

      const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
      await client.uploadFile(remotePath, updated, "utf8");
      const fileSize = Buffer.byteLength(updated, "utf8");
      const durationMs = Date.now() - t0;

      const logFile = logger.logTransfer({
        operation: "EDIT",
        host,
        port,
        protocol,
        user,
        remotePath,
        sizeBytes: fileSize,
        encoding: "utf8",
        content: updated,
        durationMs,
        status: "SUCCESS",
        details: { replacements: occurrences, oldTextLength: oldText.length, newTextLength: newText.length },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully edited ${remotePath}: replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} (file is now ${formatBytes(fileSize)}, logged to ${logFile})`
          }
        ],
        structuredContent: { remotePath, replacements: occurrences, fileSize, durationMs, logFile },
      };
    } catch (error) {
      const durationMs = Date.now() - t0;
      logger.logTransfer({
        operation: "EDIT",
        host,
        port,
        protocol,
        user,
        remotePath,
        durationMs,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult("Error editing file", error);
    }
  })
);

// Register append-file tool
server.registerTool(
  "append-file",
  {
    title: "Append to File",
    description: "Append to the end of a file on the FTP/SFTP server (creates the file if it does not exist). Give exactly one of content (a string; pass encoding \"base64\" for binary content) or localPath (a local file streamed from disk; absolute or relative to this server's working directory, a leading ~ is expanded). transferMode \"ascii\" (FTP only) converts local LF to CR LF as for upload-file; the default \"binary\" is byte-exact. File appends are logged to ftp_transfers.log.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
      content: z.string().optional().describe("Content to append to the file (give this or localPath, not both)"),
      localPath: localPathSchema("Local file to stream onto the end of the remote file (give this or content, not both)"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding of the provided content (default: utf8); not for use with localPath"),
      transferMode: transferModeSchema,
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ remotePath, content, localPath, encoding, transferMode, ...conn }) => {
    const { client, host, port, protocol, user, logger } = resolveConnection(conn);
    const t0 = Date.now();
    const enc = encoding ?? "utf8";
    const mode: TransferMode = transferMode ?? "binary";
    const problem = sourceProblem(content, localPath, encoding) ?? modeProblem(protocol, mode);
    if (problem) return errorResult("Error appending to file", new Error(problem));
    try {
      const r = localPath !== undefined
        ? await client.appendLocalFile(remotePath, localPath, mode)
        : await client.appendFile(remotePath, content!, enc, mode);
      const durationMs = Date.now() - t0;

      const logFile = logger.logTransfer({
        operation: "APPEND",
        host,
        port,
        protocol,
        user,
        remotePath,
        sizeBytes: r.localBytes,
        sha256: r.sha256,
        encoding: localPath === undefined ? enc : undefined,
        localPath: r.localPath,
        transferMode: mode,
        wireBytes: r.wireBytes,
        durationMs,
        status: "SUCCESS",
      });

      const from = r.localPath ? ` from ${r.localPath}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully appended ${formatBytes(r.localBytes)}${from} to ${remotePath} (${mode}, logged to ${logFile})`
          }
        ],
        structuredContent: {
          remotePath,
          appendedBytes: r.localBytes,
          sha256: r.sha256,
          transferMode: mode,
          ...(r.localPath ? { localPath: r.localPath } : {}),
          ...(mode === "ascii" ? { wireBytes: r.wireBytes } : {}),
          durationMs,
          logFile,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - t0;
      logger.logTransfer({
        operation: "APPEND",
        host,
        port,
        protocol,
        user,
        remotePath,
        ...(localPath !== undefined
          ? { localPath: displayLocalPath(localPath) }
          : { sizeBytes: Buffer.byteLength(content!, enc), encoding: enc, content }),
        transferMode: mode,
        durationMs,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult("Error appending to file", error);
    }
  })
);

// Initialize and run the server
async function main() {
  // Load encryption key from OS keychain before decrypting any credentials
  await loadEncryptionKey();
  try {
    defaultProtocol = resolveProtocol(process.env.FTP_PROTOCOL);
    defaultHost = process.env.FTP_HOST || "localhost";
    defaultUser = decrypt(process.env.FTP_USER || "anonymous");
    defaultPassword = decrypt(process.env.FTP_PASSWORD || "");
    defaultFtpPort = parseInt(process.env.FTP_PORT || "21", 10);
    defaultSftpPort = parseInt(process.env.FTP_PORT || "22", 10);
    defaultSecure = resolveSecure(process.env.FTP_SECURE);
    defaultPassphrase = decrypt(process.env.FTP_PASSPHRASE || "");
    defaultPrivateKeyPath = process.env.FTP_PRIVATE_KEY_PATH || "";
  } catch (error) {
    console.error(
      "Failed to initialize default connection config:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const defaultLogger = new TransferLogger();
  console.error(
    `FTP MCP Server v1.5.0 running on stdio (log directory: ${defaultLogger.getLogDir()})`
  );
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});