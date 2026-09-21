# Changelog

## Unreleased

## 1.5.0 — 2026-09-21
**Contributors**: Douglas P. Fields, Jr. (`symbolics@lisp.engineer`), with Claude Sonnet 5

### Added
- **`localPath` on `upload-file`, `append-file` and `download-file`**: stream a local file to or from the server, with no temporary copy and no size limit; only metadata (bytes, SHA-256, mode, duration) is returned, never content. `upload-file`/`append-file` take exactly one of `content` and `localPath`. `download-file` refuses to overwrite an existing local file unless `overwrite: true`, creates no directories, and never leaves a partial file at the target on failure. Works over FTP and SFTP.
- **`transferMode: "binary" | "ascii"`** (default `"binary"`) on the same three tools. FTP ASCII sends `TYPE A` and converts LF to CR LF on upload and CR LF to LF on download with a streaming converter that is correct across chunk boundaries; the connection is put back to `TYPE I` afterwards, also on failure. Rejected for SFTP. Fixes text files (e.g. OpenVMS `.COM`) arriving as fixed 512-byte records.
- Transfer log: `Mode`, `Local Path` (with a note that size and SHA-256 are of the local file) and `Wire Bytes` lines. Existing lines are unchanged.
- Results gain `sha256` and `transferMode`; `download-file` with `localPath` returns `localPath`, `bytes`, `sha256`, `transferMode` and no `content`.
- `npm test`: a suite that needs no remote machine (loopback `ftp-srv` and, for SFTP, an unprivileged `sshd`). `ftp-srv` is a dev-dependency.

### Changed
- `download-file` is no longer annotated read-only: with `localPath` it writes a local file (and can replace one with `overwrite`).
- Advertised `outputSchema`: `download-file` is a `oneOf` (content result, or local-file result); `upload-file` and `append-file` gain the new optional fields. `content` is no longer required on `upload-file` and `append-file`.
- Content-based upload and append send an in-memory stream instead of a temporary file. Download-to-content still uses a temporary file.
- `manifest.json` brought up to 1.5.0 (it still said 1.2.2) with the new tool parameters.

## 1.4.0 — 2026-09-14
**Contributors**: Douglas P. Fields, Jr. (`symbolics@lisp.engineer`)

### Added
- **Permanent transfer audit logging (`ftp_transfers.log`)**:
  - Implemented `TransferLogger` to record all file transfers and modifications (`UPLOAD`, `DOWNLOAD`, `APPEND`, `EDIT`, `DELETE`) with ISO-8601 timestamps, target host and port, username, protocol, remote file path, file size in bytes, transfer duration, transfer rate, and execution status (`SUCCESS` / `FAILED`).
  - Added cryptographic integrity hashing: automatically calculates and logs SHA-256 digests for all uploaded, downloaded, appended, and edited file payloads.
  - Added smart log directory resolution: checks `FTP_LOG_DIR`, `TELNET_LOG_DIR`, `SERIAL_LOG_DIR`, `./logs` in current workspace, or `~/.mcp-ftp-logs`. Also accepts per-transaction `log_dir` override.
  - Returned `logFile` path and `durationMs` in tool `structuredContent` across all transfer tools for programmatic consumption by AI agents.

## 1.3.0 — 2026-09-13
**Contributors**: Douglas P. Fields, Jr. (`symbolics@lisp.engineer`)

### Added
- **Dynamic per-transaction connection parameters**: All nine tools (`list-directory`, `download-file`, `upload-file`, `create-directory`, `delete-file`, `delete-directory`, `rename-file`, `edit-file`, `append-file`) now accept optional `host`, `port`, `protocol`, `user`, `password`, and `secure` arguments. This allows an AI agent to target multiple FTP/SFTP servers dynamically from a single MCP server instance.
- **OpenVMS TCP/IP Services FTP support**:
  - Implemented `parseVmsList` parser fallback in `FtpClient` to recognize and parse OpenVMS directory listings (`FILENAME.EXT;VER`, 512-byte blocks, timestamps, `*.DIR;*` directories, and multi-line continuation entries).
  - Versioned deletion fallback: OpenVMS `DELE` requires a version number; unversioned deletions now automatically retry with `;0` (latest version) upon receiving a version requirement error from OpenVMS.
  - Directory path normalization: `.` and `./` are mapped to `""` so default directory listings succeed under OpenVMS syntax.
- **Graceful environment fallback**: When connection arguments are omitted from a tool call, the server falls back to environment variables (`FTP_HOST`, `FTP_PORT`, `FTP_USER`, etc.), preserving full backward compatibility with single-host configurations.

## 1.2.2 — 2026-09-10

### Fixed
- Preserve all nine advertised `outputSchema` definitions while rewriting the SDK's draft-07 `$schema` URI to JSON Schema 2020-12 on stdio responses. This keeps structured output metadata available to clients such as Smithery while avoiding rejection by clients that require 2020-12.

## 1.2.1 — 2026-08-07

### Added
- `FTP_PRIVATE_KEY_PATH` now accepts a 1Password secret reference (`op://vault/item/field`), resolved via the 1Password CLI (`op read`) so the SFTP private key never has to live in a file on disk. The key is cached in memory for the process lifetime; plain file paths and `~/.ssh` auto-detection are unchanged.

## 1.2.0 — 2026-07-21

### Added
- **Structured output**: every tool now declares an `outputSchema` and returns `structuredContent` alongside the human-readable text, so agents can consume results without parsing prose.
- **Tool annotations**: read-only, destructive, and idempotent hints on all tools, letting clients apply appropriate confirmation policies (e.g. `delete-file` is flagged destructive; `list-directory` and `download-file` are read-only).

### Changed
- All connection settings in the Smithery/MCPB manifest are now optional, matching the server's actual defaults (localhost, port 21, anonymous).

## 1.1.0 — 2026-07-21

### Fixed
- **Binary file corruption**: downloads and uploads previously forced `utf8` encoding, corrupting any binary file (zips, images, etc.). Downloads now detect binary content and return it base64-encoded; uploads accept an optional `encoding: "base64"` parameter.
- **FTP connection leak**: the FTP client leaked connections when an operation threw. Every operation now disconnects in a `finally` block (matching the SFTP client's behavior).
- **Temp file cleanup**: downloaded temp files are now always removed, including on error.
- **`build-windows.bat`**: removed the broken fallback that copied `.ts` files as `.js` when compilation failed; a failed build now exits with an error instead of producing a runtime-crashing "success".

- **Concurrent tool-call races**: the MCP SDK dispatches tool calls concurrently, so parallel calls could race each other (concurrent edits silently lost updates in testing). All tool calls now run through an operation queue, making each operation atomic. Ordering between calls issued in parallel is still the client's responsibility — await each result before a dependent call.
- **Temp-file name collisions**: temp files were named with `Date.now()`, so two operations in the same millisecond could share (and delete) each other's temp file. Names now use `randomUUID()`.

### Added
- `FTP_ENCRYPTION_KEY` can now be stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) instead of the config file, via `npm run store-key` — thanks @rencsaridogan ([#7](https://github.com/alxspiker/mcp-server-ftp/pull/7)). Falls back to the environment variable, so existing setups are unaffected.
- New `rename-file` tool to rename or move files and directories (FTP and SFTP).
- New `edit-file` tool: replaces an exact string in a text file so the model doesn't have to re-upload the entire file content. Requires the match to be unique (or `replaceAll: true`) and refuses binary files.
- New `append-file` tool: appends to a file (native `APPE` on FTP, append on SFTP); creates the file if missing.

### Changed
- Migrated tool registration to the current MCP SDK API (`registerTool` with titles); minimum SDK version is now `^1.12.0`.
- Minimum supported Node version is now 18.14.
