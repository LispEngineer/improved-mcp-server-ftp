# Improved MCP Server for FTP

Improvements:

* Support per-connection destination and credentials
* Support VMS conventions
* Persistent transfer audit logging (`ftp_transfers.log`) with timestamps, file 
  sizes, transfer durations, and SHA-256 integrity hashes

Improver: Douglas P. Fields, Jr. (`symbolics@lisp.engineer`) with Gemini 3.8 Flash

---

[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/alxspiker-mcp-server-ftp-badge.png)](https://mseep.ai/app/alxspiker-mcp-server-ftp)

# MCP Server for FTP, FTPS, and SFTP Access

[![smithery badge](https://smithery.ai/badge/alxspikers-team/mcp-server-ftp)](https://smithery.ai/servers/alxspikers-team/mcp-server-ftp)

This Model Context Protocol (MCP) server provides file-management tools for FTP, FTPS, and SFTP servers. It supports directory listing, binary-safe downloads/uploads, text edits, appends, renames/moves, directory creation, and deletion.

## Protocol support

- **FTP** — traditional FTP, normally on port 21.
- **FTPS** — FTP secured with TLS. Use `FTP_PROTOCOL=ftp` and `FTP_SECURE=true`.
- **SFTP** — SSH File Transfer Protocol, normally on port 22. SFTP is a different protocol from FTPS and is already encrypted by SSH, so `FTP_SECURE` does not apply to it.

## Features

- List files and directories
- Download and upload text or binary files
- Edit exact text in remote files
- Append to files
- Rename or move files/directories
- Create and delete directories
- Dynamic per-transaction connection parameters (`host`, `port`, `protocol`, `user`, `password`, `secure`, `log_dir`)
- Permanent transfer audit logging (`ftp_transfers.log`) with timestamps, file sizes, SHA-256 integrity hashes, and duration metrics
- Flexible log directory resolution (`log_dir` parameter, `FTP_LOG_DIR`, `TELNET_LOG_DIR`, `SERIAL_LOG_DIR`, `./logs`, or `~/.mcp-ftp-logs`)
- OpenVMS TCP/IP Services FTP support (OpenVMS directory parser and versioned deletion)
- FTP, FTPS, and SFTP support
- SFTP password or SSH private-key authentication
- Optional 1Password CLI private-key resolution
- AES-256-GCM encrypted credential values
- OS-keychain support for the encryption key

## Installation

### Installing via Smithery

```bash
npx -y @smithery/cli install alxspikers-team/mcp-server-ftp --client claude
```

### Prerequisites

- Node.js 18.14 or newer
- An MCP-compatible client such as Claude Desktop

### Installing via npm

The server is published as [`mcp-server-ftp`](https://www.npmjs.com/package/mcp-server-ftp):

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "npx",
      "args": ["-y", "mcp-server-ftp"],
      "env": {
        "FTP_HOST": "ftp.example.com"
      }
    }
  }
}
```

### Building from source

```bash
git clone https://github.com/alxspiker/mcp-server-ftp.git
cd mcp-server-ftp
npm install
npm run build
```

## Configuration

### FTP example

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "ftp.example.com",
        "FTP_PORT": "21",
        "FTP_PROTOCOL": "ftp",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password"
      }
    }
  }
}
```

### FTPS example

FTPS uses the normal FTP client with TLS enabled:

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "ftps.example.com",
        "FTP_PORT": "21",
        "FTP_PROTOCOL": "ftp",
        "FTP_SECURE": "true",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password"
      }
    }
  }
}
```

`FTP_SECURE` is only meaningful when `FTP_PROTOCOL=ftp`. It is ignored by the SFTP path because SFTP is already encrypted over SSH.

### SFTP example

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "sftp.example.com",
        "FTP_PORT": "22",
        "FTP_PROTOCOL": "sftp",
        "FTP_USER": "your-username",
        "FTP_PRIVATE_KEY_PATH": "~/.ssh/id_ed25519",
        "FTP_PASSPHRASE": "your-key-passphrase"
      }
    }
  }
}
```

### Configuration options

| Environment variable | Applies to | Description | Default |
|---|---|---|---|
| `FTP_HOST` | all | Server hostname or IP address | `localhost` |
| `FTP_PORT` | all | Server port | `21` for FTP/FTPS, `22` for SFTP |
| `FTP_PROTOCOL` | all | `ftp` or `sftp` | `ftp` |
| `FTP_USER` | all | Username; supports encrypted `enc:` values | `anonymous` |
| `FTP_PASSWORD` | all | Password; supports encrypted `enc:` values | empty |
| `FTP_SECURE` | FTP/FTPS only | Enables TLS/FTPS for the FTP client | `false` |
| `FTP_PRIVATE_KEY_PATH` | SFTP only | SSH private-key path or `op://` 1Password secret reference | auto-detect |
| `FTP_PASSPHRASE` | SFTP only | SSH private-key passphrase; supports encrypted `enc:` values | empty |
| `FTP_ENCRYPTION_KEY` | encrypted credentials | 64-character hex AES-256 key. Prefer the OS keychain or a global environment variable for local installs. | disabled |
| `FTP_LOG_DIR` | all | Directory path for persistent `ftp_transfers.log` audit log | `TELNET_LOG_DIR`, `./logs` (if present), or `~/.mcp-ftp-logs` |

## SFTP authentication

SFTP supports private-key and password authentication.

The server looks for a private key in this order:

1. `FTP_PRIVATE_KEY_PATH`, if set
2. `~/.ssh/id_ed25519`
3. `~/.ssh/id_rsa`
4. `~/.ssh/id_ecdsa`

If no key is found, `FTP_PASSWORD` is used.

### Reading an SFTP key from 1Password

`FTP_PRIVATE_KEY_PATH` may contain a 1Password secret reference instead of a filesystem path:

```json
"FTP_PRIVATE_KEY_PATH": "op://Private/my-server/private key"
```

Requirements:

- The 1Password CLI (`op`) must be installed and available on `PATH`.
- The CLI must already be able to authenticate, either through the desktop-app integration or `OP_SERVICE_ACCOUNT_TOKEN`.

The key is resolved lazily, cached in memory for the process, and is not written to disk.

If the SSH server rejects 1Password's default exported key format, request OpenSSH format:

```json
"FTP_PRIVATE_KEY_PATH": "op://Private/my-server/private key?ssh-format=openssh"
```

## Credential encryption

`FTP_USER`, `FTP_PASSWORD`, and `FTP_PASSPHRASE` may be stored as AES-256-GCM encrypted values using the `enc:` format.

### Generate an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Store the key in the OS keychain (recommended for local installs)

```bash
npm run build
npm run store-key -- <your-64-char-hex-key>
```

The server loads the key from macOS Keychain, Windows Credential Manager, or Linux Secret Service when available.

Alternatively, set the key globally in the process environment:

```bash
export FTP_ENCRYPTION_KEY=<your-64-char-hex-key>
```

Do not place `FTP_ENCRYPTION_KEY` beside the encrypted credentials in the same local MCP config unless your deployment environment gives you no separate secret-storage mechanism.

### Encrypt a value

```bash
npm run build
FTP_ENCRYPTION_KEY=<your-64-char-hex-key> npm run encrypt-env -- <plaintext-value>
```

If the key is already available from the OS keychain or shell environment:

```bash
npm run encrypt-env -- <plaintext-value>
```

## Available tools

| Tool | Description |
|---|---|
| `list-directory` | List contents of a remote directory |
| `download-file` | Download a file; binary content is returned as base64 |
| `upload-file` | Upload text or base64-encoded binary content |
| `create-directory` | Create a directory |
| `delete-file` | Delete a file |
| `delete-directory` | Delete a directory |
| `rename-file` | Rename or move a file or directory |
| `edit-file` | Replace exact text in a remote text file |
| `append-file` | Append content to a file, creating it if needed |

Tool calls return machine-readable `structuredContent`, and all nine tools advertise output schemas. Version 1.2.2 includes a compatibility shim that ensures advertised schemas use the JSON Schema 2020-12 dialect required by current MCP clients.

## Dynamic connection parameters (multi-host targeting)

Starting in version 1.3.0, AI agents can pass connection parameters directly in any tool call. This allows a single MCP server instance to interact with multiple FTP/SFTP hosts dynamically without requiring separate server configurations.

### Supported transaction parameters

| Parameter | Type | Description | Default |
|---|---|---|---|
| `host` | `string` | Target server hostname or IP address | `FTP_HOST` env var or `localhost` |
| `port` | `integer` | Port number | `FTP_PORT` env var or `21` (FTP) / `22` (SFTP) |
| `protocol` | `string` | `"ftp"` or `"sftp"` | `FTP_PROTOCOL` env var or `"ftp"` |
| `user` | `string` | Username for authentication | `FTP_USER` env var or `"anonymous"` |
| `password` | `string` | Password for authentication | `FTP_PASSWORD` env var or empty |
| `secure` | `boolean` | Enable FTPS / TLS (FTP only) | `FTP_SECURE` env var or `false` |
| `log_dir` | `string` | Target directory for transfer audit log (`ftp_transfers.log`) | `FTP_LOG_DIR` env var or smart fallback |

If any parameter is omitted from a tool call, the server automatically falls back to the corresponding environment variable or default, preserving full backward compatibility with single-host configurations.

### Dynamic tool call example

```json
{
  "name": "list-directory",
  "arguments": {
    "host": "192.168.3.201",
    "user": "USER1",
    "password": "user1pass",
    "remotePath": ""
  }
}
```

## Transfer Logging

Starting in version 1.4.0, all file operations (`upload-file`, `download-file`, `append-file`, `edit-file`, and `delete-file`) are permanently recorded to a transfer audit log (`ftp_transfers.log`), modeled after the session logging mechanism in `chuk-mcp-telnet-client`.

### Logged metadata
Each transfer event records a structured human-readable block containing:
- **ISO-8601 Timestamp** of the operation
- **Operation type & status** (`UPLOAD`, `DOWNLOAD`, `APPEND`, `EDIT`, `DELETE` — `SUCCESS` or `FAILED`)
- **Target host, port, protocol, and username**
- **Remote file path**
- **File size** in bytes and human-readable units (B, KB, MB, GB)
- **SHA-256 integrity hash** computed automatically from the transferred or modified payload
- **Transfer duration** (in milliseconds) and effective transfer speed (e.g. `KB/s`)
- **Error details** if the operation failed

### Example log entry
```text
================================================================================
[2026-09-14T19:15:30.123Z] FTP TRANSFER: UPLOAD - SUCCESS
Target       : 192.168.3.204:21 (USER1)
Protocol     : FTP
Remote Path  : TEST_LOG.TXT
Size         : 42 B (42 bytes)
Encoding     : utf8
SHA-256      : a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e
Duration     : 145 ms (289.66 B/s)
================================================================================
```

### Log directory resolution
The logger resolves the destination log directory in the following priority:
1. Per-tool `log_dir` parameter passed directly in the tool call.
2. `FTP_LOG_DIR` environment variable.
3. `TELNET_LOG_DIR` or `SERIAL_LOG_DIR` environment variable (for project-wide session logging compatibility).
4. `./logs` directory in the current working directory, if it exists.
5. Default global fallback: `~/.mcp-ftp-logs`.

### Programmatic tool response
All transfer tools return `logFile` (the absolute path to `ftp_transfers.log`) and `durationMs` inside their `structuredContent` payload, allowing AI agents to confirm logging and verify transfer integrity.

## OpenVMS Support

Version 1.3.0 includes native support for OpenVMS TCP/IP Services FTP servers:
- **Directory listing parser**: Dedicated fallback parser for OpenVMS `LIST` output (`FILENAME.EXT;VER`, 512-byte blocks, ISO date conversion, `*.DIR;*` subdirectories, and 2-line wrapped entries).
- **Versioned deletion**: Automatically retries unversioned deletions with `;0` (latest version) when OpenVMS requires a version specification.
- **Path normalization**: Translates `.` and `./` to `""` for current-directory listings.

## Security notes

- Prefer SFTP when available; it uses SSH encryption and key authentication without FTPS certificate configuration.
- Use `FTP_SECURE=true` only for FTPS servers using the FTP protocol path.
- Use credential encryption when a client configuration would otherwise contain plaintext credentials.
- FTP and SFTP transfers may use short-lived local temporary files for upload/download/append operations; those files are removed during cleanup after each operation.

## Troubleshooting Windows builds

1. Confirm Node.js 18.14 or newer and npm are installed.
2. Run `npm install`.
3. Run `npm run build` or `npx tsc`.
4. Start the compiled server with `node build/index.js`.

## Credits and Authorship

- **Original Author**: [alxspiker](https://github.com/alxspiker) (https://github.com/alxspiker/mcp-server-ftp)
- **Contributors**:
  - **Douglas P. Fields, Jr.** (`symbolics@lisp.engineer`):
    - Version 1.3.0 — Dynamic per-transaction host and credential parameters, OpenVMS directory listing parser, OpenVMS versioned deletion semantics, and graceful environment fallback.
    - Version 1.4.0 — Persistent transfer audit logging (`ftp_transfers.log`) with ISO timestamps, file sizes, SHA-256 integrity hashes, transfer rate metrics, and configurable log directories mirroring the Telnet/Serial MCP architecture.

## License

MIT
