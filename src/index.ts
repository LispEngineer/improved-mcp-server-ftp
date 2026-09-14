#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FtpClient, FtpConfig } from "./ftp-client.js";
import { SftpClient, SftpConfig } from "./sftp-client.js";
import { decrypt } from "./crypto.js";
import { ConnectionType } from "./connection-type.js";
import { loadEncryptionKey } from "./keychain.js";

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
};

interface ConnectionArgs {
  host?: string;
  port?: number;
  protocol?: "ftp" | "sftp";
  user?: string;
  password?: string;
  secure?: boolean;
}

type AnyFtpClient = FtpClient | SftpClient;

function getClient(conn: ConnectionArgs): AnyFtpClient {
  const protocol = conn.protocol ? resolveProtocol(conn.protocol) : defaultProtocol;
  const host = conn.host || defaultHost;
  const user = conn.user !== undefined ? decrypt(conn.user) : defaultUser;
  const password = conn.password !== undefined ? decrypt(conn.password) : defaultPassword;

  if (protocol === ConnectionType.SFTP) {
    const sftpConfig: SftpConfig = {
      host,
      port: conn.port ?? defaultSftpPort,
      user,
      password,
      passphrase: defaultPassphrase,
      privateKeyPath: defaultPrivateKeyPath,
    };
    return new SftpClient(sftpConfig);
  } else {
    const ftpConfig: FtpConfig = {
      host,
      port: conn.port ?? defaultFtpPort,
      user,
      password,
      secure: conn.secure !== undefined ? conn.secure : defaultSecure,
    };
    return new FtpClient(ftpConfig);
  }
}

// Create server instance
const server = new McpServer({
  name: "mcp-server-ftp",
  version: "1.3.0",
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
    description: "List contents of an FTP/SFTP directory. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory on the FTP server"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    try {
      const client = getClient(conn);
      const listing = await client.listDirectory(remotePath);

      // Format the output
      const formatted = listing.map((item) =>
        `${item.type === "directory" ? "[DIR]" : "[FILE]"} ${item.name} ${item.type === "file" ? `(${formatSize(item.size)})` : ""} - ${item.modifiedDate}`
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
    description: "Download a file from the FTP/SFTP server. Text files are returned as-is; binary files are returned base64-encoded. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    try {
      const client = getClient(conn);
      const { content, encoding } = await client.downloadFile(remotePath);

      const header = encoding === "base64"
        ? `File content of ${remotePath} (binary, base64-encoded):`
        : `File content of ${remotePath}:`;

      return {
        content: [
          {
            type: "text" as const,
            text: `${header}\n\n${content}`
          }
        ],
        structuredContent: { remotePath, content, encoding },
      };
    } catch (error) {
      return errorResult("Error downloading file", error);
    }
  })
);

// Register upload-file tool
server.registerTool(
  "upload-file",
  {
    title: "Upload File",
    description: "Upload a file to the FTP/SFTP server. Pass encoding \"base64\" to upload binary content. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Destination path on the FTP server"),
      content: z.string().describe("Content to upload to the file"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding of the provided content (default: utf8)"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, content, encoding, ...conn }) => {
    try {
      const client = getClient(conn);
      const enc = encoding ?? "utf8";
      await client.uploadFile(remotePath, content, enc);

      return {
        content: [
          {
            type: "text" as const,
            text: `File successfully uploaded to ${remotePath}`
          }
        ],
        structuredContent: { remotePath, bytesWritten: Buffer.byteLength(content, enc) },
      };
    } catch (error) {
      return errorResult("Error uploading file", error);
    }
  })
);

// Register create-directory tool
server.registerTool(
  "create-directory",
  {
    title: "Create Directory",
    description: "Create a new directory on the FTP/SFTP server. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory to create"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    try {
      const client = getClient(conn);
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
    description: "Delete a file from the FTP/SFTP server. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file to delete"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    try {
      const client = getClient(conn);
      await client.deleteFile(remotePath);

      return {
        content: [
          {
            type: "text" as const,
            text: `File successfully deleted from ${remotePath}`
          }
        ],
        structuredContent: { remotePath, deleted: true },
      };
    } catch (error) {
      return errorResult("Error deleting file", error);
    }
  })
);

// Register delete-directory tool
server.registerTool(
  "delete-directory",
  {
    title: "Delete Directory",
    description: "Delete a directory from the FTP/SFTP server. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory to delete"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, ...conn }) => {
    try {
      const client = getClient(conn);
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
    description: "Rename or move a file or directory on the FTP/SFTP server. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      fromPath: z.string().describe("Current path of the file or directory"),
      toPath: z.string().describe("New path for the file or directory"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ fromPath, toPath, ...conn }) => {
    try {
      const client = getClient(conn);
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
    description: "Edit a text file on the FTP/SFTP server by replacing an exact string, without re-uploading the whole file content. oldText must match exactly (including whitespace) and be unique in the file unless replaceAll is set. Optionally specify host, port, protocol, user, and password per transaction.",
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
    try {
      if (oldText === "") {
        return errorResult("Error editing file", new Error("oldText must not be empty"));
      }
      if (oldText === newText) {
        return errorResult("Error editing file", new Error("oldText and newText are identical; nothing to change"));
      }

      const client = getClient(conn);
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

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully edited ${remotePath}: replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} (file is now ${formatSize(fileSize)})`
          }
        ],
        structuredContent: { remotePath, replacements: occurrences, fileSize },
      };
    } catch (error) {
      return errorResult("Error editing file", error);
    }
  })
);

// Register append-file tool
server.registerTool(
  "append-file",
  {
    title: "Append to File",
    description: "Append content to the end of a file on the FTP/SFTP server (creates the file if it does not exist). Pass encoding \"base64\" for binary content. Optionally specify host, port, protocol, user, and password per transaction.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
      content: z.string().describe("Content to append to the file"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding of the provided content (default: utf8)"),
      ...connectionParamsSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ remotePath, content, encoding, ...conn }) => {
    try {
      const client = getClient(conn);
      const enc = encoding ?? "utf8";
      await client.appendFile(remotePath, content, enc);
      const appendedBytes = Buffer.byteLength(content, enc);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully appended ${formatSize(appendedBytes)} to ${remotePath}`
          }
        ],
        structuredContent: { remotePath, appendedBytes },
      };
    } catch (error) {
      return errorResult("Error appending to file", error);
    }
  })
);

// Helper function to format file sizes
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
  else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  else return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

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
  console.error("FTP MCP Server v1.3.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});