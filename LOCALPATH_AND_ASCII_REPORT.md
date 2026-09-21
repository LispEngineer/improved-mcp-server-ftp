# Report: `localPath` streaming and ASCII mode (1.5.0)

Douglas P. Fields, Jr. (`symbolics@lisp.engineer`). Work done 21-SEP-2026 by a Claude
Sonnet 5 session ("ftp-mcp-fix", high effort, no advisor) on branch
`localpath-and-ascii`, from the brief `FTP_MCP_LOCALPATH_AND_ASCII_BRIEF.md` in the
`vms-exploration` repository. Nothing is pushed or merged.

## 0. Before anything else

* **`build/` was rebuilt, so this IS the install.** `~/.local/bin/mcp-server-ftp` points at
  `build/index.js`. Every other Claude session must **reconnect the MCP server (`/mcp`)** to
  get the new tool schema; until then it still advertises the 1.4.0 tools, which have no
  `localPath` or `transferMode`. Sessions already running keep the old process in memory.
* **Rollback copy:** `build.20260921-070308/` (a full copy of the 1.4.0 build, ignored by git).
  To go back: `rm -rf build && mv build.20260921-070308 build`, then `/mcp` again.
* I found and fixed one defect in my own work late (section 6, "The outputSchema bug"). The
  VMS run in section 5 predates that fix. The transfer code did not change with it; only the
  schema the server advertises did.

## 1. What changed

Eight commits on `localpath-and-ascii` (`git log --oneline main..localpath-and-ascii`); the seven
below, plus the one that adds this report:

```
04cfe98 Version 1.5.0: docs, changelog, manifest
74c66df Advertise the new result shapes in outputSchema; tests now validate it
f92dd10 Test SFTP localPath against a real sshd on loopback
78374cf Tools: localPath and transferMode on upload-file, download-file, append-file
f1a34b2 FTP/SFTP clients: stream local files, ASCII mode with TYPE restore; logger fields
bd1ffca Add streaming LF<->CR LF converters and local-file transfer helpers
7c4f12a Add npm test suite: loopback FTP server (ftp-srv) driving the real MCP server
```

| File | Change |
|---|---|
| `src/text-mode.ts` (new) | `LfToCrlf` (upload) and `CrlfToLf` (download): stateful streaming converters. A CR ending one chunk and an LF starting the next are treated as a pair. A CR LF already present is not doubled. A lone CR is data and passes through. |
| `src/transfer.ts` (new) | `TransferMode`, `LocalTransferResult`, `resolveLocalPath` (absolute, `~`, or relative to the server's cwd), `requireLocalSource`, and the download-target protocol `prepareDownloadTarget` / `commitDownload` / `discardTemp`. `hashLocalFile`. |
| `src/ftp-client.ts` | `withTransferType()` (exported): `TYPE A` before, `TYPE I` after, also on failure. `receiveToFile` and `sendFromSource` are the two streaming cores. New public methods `uploadLocalFile`, `appendLocalFile`, `downloadToLocal`. `uploadFile` / `appendFile` / `downloadFile` gained a `mode` parameter; content uploads and appends now send an in-memory stream rather than a temp file. |
| `src/sftp-client.ts` | Same three local-file methods (`fastPut`, `fastGet`, `append` stream); `"ascii"` throws a clear message. |
| `src/index.ts` | `localPath`, `overwrite`, `transferMode` on the three tools; `sourceProblem()` (exactly one of `content`/`localPath`, no `encoding` with `localPath`) and `modeProblem()` (SFTP + ascii); tool descriptions; results add `sha256`, `transferMode`; version 1.5.0. |
| `src/logger.ts` | Optional `Mode`, `Local Path` (+ a note that size and SHA-256 are of the local file) and `Wire Bytes` lines. Existing lines untouched. Content is never logged for `localPath`. |
| `src/schema-compat-install.ts` | Advertised `outputSchema`s updated (section 6). |
| `test/*.ts`, `tsconfig.test.json` | The suite. `npm test` compiles to `build-test/` (git-ignored), never `build/`. |
| `package.json` | 1.5.0; `test` script; `ftp-srv` dev-dependency. |
| `README.md`, `CHANGELOG.md`, `manifest.json` | Documented. `manifest.json` said 1.2.2; it is now 1.5.0 with the new parameters. |

Download-to-file: the destination is validated **before connecting**; bytes go to a hidden
sibling `.<name>.mcp-part-<8 hex>` opened `wx`, and are moved into place only on success
(`rename` with `overwrite`, an exclusive hard link without it, falling back to an exclusive
copy). So a failed or refused download leaves nothing at the target and no stray file.

## 2. Connection reuse and `TYPE I` restoration (what I found, what I did, why)

**The premise in the brief does not hold for this code.** `FtpClient.withConnection` opens a
**fresh `basic-ftp` connection for every operation** and closes it in `finally`. Nothing is
pooled or reused, so today an ASCII transfer cannot corrupt a later binary one; the next
operation logs in again and `basic-ftp` sends `TYPE I` at login.

I still did both things the brief allowed: `withTransferType()` restores `TYPE I` in a
`finally` (best effort; if the connection is already gone there is nothing to restore), **and**
connections remain per-operation. Reason: it costs one round trip on ASCII transfers only, and
it keeps the code correct if someone later adds pooling. It is tested directly on one shared
`basic-ftp` `Client` (`TYPE restoration on a reused connection`, 2 tests, including the failure
path), because the tool level cannot exercise a shared connection.

## 3. Test framework choice

`ftp-srv` (npm, dev-dependency), not `pyftpdlib`. `pyftpdlib` is not installed here, and, more
to the point, it converts line endings itself in ASCII mode, which would hide exactly what the
tests must see. `ftp-srv` records `TYPE` but stores the bytes it receives untranslated, so a
file in its root directory **is** the wire form. The tests hook its `write`/`read` to record the
`TYPE` in force at the start of each transfer.

For SFTP the tests start a real OpenSSH `sshd` (`/usr/bin/sshd`) unprivileged on a free
loopback port: throw-away host and client keys, key-only auth, `AllowUsers` the current user,
removed afterwards. The SFTP describe is skipped, not failed, where `sshd` is missing.

The tests drive the **real MCP server over stdio** with the SDK client, so they test what an
agent's tool call does. Two converters/`withTransferType` tests import the modules directly.

## 4. Test output: failing on 1.4.0, then passing

### Against unmodified 1.4.0

Method: `git archive main` extracted to a scratch directory, the new `test/` and
`tsconfig.test.json` copied in, `node_modules` symlinked, `npm test` run. (That tree's
`src/index.ts` contains no `localPath`.) Final suite of 43 tests:

```
ℹ tests 43
ℹ suites 8
ℹ pass 5
ℹ fail 38
```

The 5 that pass are the pre-existing behaviours, which is the point: `utf8 upload, download,
list, edit, delete`; `base64 upload and download of binary content is byte-exact`; `append with
content, and the existing log line format, are intact`; and the two `empty content is still
valid content` tests. Every new test fails, and for the right reason, e.g.:

```
✖ upload of a missing or non-regular local path is a clear error
  MCP error -32602: Input validation error: Invalid arguments for tool upload-file: Required at content
✖ upload-file: transferMode ascii is rejected for SFTP before any connection is made
  actual: 'Error uploading file: getConnection: connect ECONNREFUSED 127.0.0.1:1'
  expected: /SFTP has no ASCII/i
✖ ASCII upload of content (not localPath) is converted too
  actual: 'x\ny\n'   expected: 'x\r\ny\r\n'          (unknown transferMode is silently dropped: bytes went out LF-only, as TYPE I)
✖ withTransferType leaves the connection in TYPE I ...
  actual: 'undefined'   expected: 'function'
```

The first run, before the SFTP tests and the schema tests were added, was 37 tests: 5 pass,
32 fail. Full outputs were kept in the session scratchpad (not in this repository).

The schema bug (section 6) was demonstrated failing separately, on the 1.5.0 code before its
fix:

```
Error [McpError]: MCP error -32602: Structured content does not match the tool's output schema:
data must have required property 'content', data must have required property 'encoding'
```

### Against 1.5.0 (this branch)

```
ℹ tests 43
ℹ suites 8
ℹ pass 43
ℹ fail 0
ℹ skipped 0
```

Then, after `npm run build`, the **whole suite was run again against the installed
`build/index.js`** (`MCP_FTP_SERVER_JS=.../build/index.js npm test`): 43 of 43. No test
directories or `sshd` processes were left behind (checked).

Brief item by item: (1) 50 MB random file, localPath round trip, SHA-256 equal, results under
4 KB and contain no content: pass. (2) overwrite refusal (also: existing file untouched, no
partial file, no directory creation, missing remote file leaves nothing): pass. (3) ASCII LF ->
CR LF on the server, CR LF -> LF back, binary straight afterwards byte-exact and `TYPE I`:
pass, at tool level and on a shared client. (4) content + localPath together, and neither:
rejected, for both upload and append. (5) utf8 and base64 content uploads: pass.

## 5. VMS acceptance test (real): VSIM9, as USER1

Target named by the operator: **VSIM9** at `10.73.0.109` (the address in the simulator
project's `VSIM10_REPORT.md`; also in `EMACS_21_COMPLETION_CRASH_HANDOFF.md`). It is a
**SIMH-simulated** MicroVAX running OpenVMS VAX V7.3, not real hardware. Account `USER1`
only. The `savage-work-continued` session was told before and after, and replied that nothing
of theirs was running.

* Scratch directory `SYS$SYSDEVICE:[HOME.USER1.FTPTEST_0921]` created **over telnet**
  (`CREATE/DIRECTORY`); no directory was created by FTP.
* Telnet transcript (typed input included, so it holds the lab password):
  `~/src/vms-exploration/logs/ftpmcp-vsim9-user1.log`.
  FTP side: `logs/ftp-mcp-1.5.0-vsim9-ftp_transfers.log` (the server's own transfer log) and
  `logs/ftp-mcp-1.5.0-vsim9-roundtrip-driver-output.txt`, same directory.

| Step | Measured |
|---|---|
| Upload 3-line `.COM` (89 bytes, LF only), `transferMode: "ascii"` | Result: 89 local bytes, **92 on the wire** (three CRs added). `DIRECTORY/FULL`: `Record format: Variable length, maximum 0 bytes, longest 40 bytes`, `Record attributes: Carriage return carriage control`. `@[.FTPTEST_0921]ASC3.COM` **ran**: printed `FTP MCP TEST LINE 1` and `2`. |
| Same file, `transferMode: "binary"` (the known-bad) | `DIRECTORY/FULL`: `Record format: Fixed length 512 byte records`. `@` gave `%RMS-W-RTB, 512 byte record too large for user's buffer`. So the test can fail. |
| 3 MiB random binary (3,145,728 bytes) up and down by `localPath` | SHA-256 **equal** (`75a787ed...60d1`); 6144 blocks on VMS. About 0.4 s each way. |
| Extra: 1,000,003 bytes (not a multiple of 512) | SHA-256 **equal**, size back exactly 1,000,003 although VMS holds 1954 blocks. |
| Extra: ASCII download of the `.COM` back | Returned the original 89 bytes, SHA-256 equal to the local original. |
| Cleanup | `delete-file` of `FILE.EXT;*` worked for all four files. `DIRECTORY` showed the directory empty. The `.DIR` needed `SET PROTECTION=(O:RWED)` first (the default lacks owner delete, `%RMS-E-PRV`), then `DELETE`. Verified nothing named `FTPTEST*` remained. `LOGOUT` at 09:59:42 VSIM9 time, session closed. |

Consistent with what the `savage-work-continued` session measured independently: on this
TCP/IP Services FTP server an ASCII `STOR` does **not** produce Stream_LF; it produces
variable-length records with CR carriage control.

**How the VMS run was driven, and the caveat.** This session's own `ftp-server` MCP tools are
still the 1.4.0 process with the 1.4.0 schema (they cannot be reconnected from inside a
session), so they cannot pass `localPath`. I ran the transfers through a small Node script in
the session scratchpad (not in either repository) that starts the freshly built server
(`build-test/src/index.js`, compiled from exactly the committed source that `build/` now
holds) and calls its tools over real MCP with the SDK client. Telnet steps used the configured
telnet MCP tools. The password is an environment variable in that script's command line and
is written to no repository. That script did not list tools, hence did not validate results
against the advertised schema, which is why it did not catch the bug below.

## 6. The outputSchema bug I found in my own work

`src/schema-compat-install.ts` advertises a per-tool `outputSchema`, and clients validate
`structuredContent` against it. `download-file`'s schema **required `content` and `encoding`**,
so the new metadata-only result of a `localPath` download would have been rejected by any
validating client (error text in section 4). My first test client never called `listTools`, so
it never validated, and neither did the VMS driver. Fixed in `74c66df`: `download-file`'s
schema is now a `oneOf` (content result, or `localPath` + `bytes` + `sha256`), and the upload
and append schemas gain the new optional fields. The test client now lists tools, so **every
tool-level test also checks the advertised schema**, and two tests state it. Not tested: Claude
Code's own client. I assume it validates like the SDK client does.

## 7. Measured, and assumed (kept apart)

**Measured**
* 43/43 tests pass on the 1.5.0 source and on the installed `build/index.js`; 5/43 on 1.4.0.
* FTP over loopback (`ftp-srv`), SFTP over loopback (real OpenSSH), and the VSIM9 results in
  section 5.
* ASCII mode puts CR LF on the wire and TYPE A on the control connection; binary straight
  after is byte-exact with TYPE I (server-recorded).
* Converters are correct at every 2-way split point and byte-at-a-time.
* On VMS TCP/IP Services (SIMH V7.3): ASCII -> variable length + CR carriage control, runs;
  binary -> fixed 512, does not run; block-multiple and non-multiple binaries round-trip
  exactly; `;*` delete works.

**Assumed, not measured**
* **Real hardware.** Only the simulator VSIM9 was tested. That real VAX60/VAX96 behave the
  same rests on the savage session's report (second-hand; I did not touch them).
* **FTPS** (`secure: true`) with `localPath` or ASCII: no TLS test server was run.
* **The 76 MB case that started all this.** 50 MB tested on loopback; 3 MiB on VMS. I assume
  a 76 MB saveset works and stays flat in memory (data flows in chunks, nothing is buffered
  whole), and that `basic-ftp`'s default inactivity timeout does not bite on a slow simulator
  link. Not run at that size.
* **SFTP against anything but OpenSSH on loopback**, and Windows (path handling; the
  hard-link fallback to an exclusive copy is untested).
* SFTP `localPath` upload/append report the SHA-256 by re-reading the local file after the
  transfer; that assumes it did not change meanwhile (FTP hashes the bytes as they are sent).
* **`edit-file` on VMS.** It still downloads and uploads in binary. From reading the code, an
  edit of a VMS text file will rewrite it as fixed 512-byte records. Not tested; out of scope.
* Performance figures are loopback and simulator numbers and mean nothing for real links.

## 8. Anything in the brief that was wrong or incomplete

1. **"Check how `withConnection` manages connections"**: it does not pool at all (section 2),
   so the corruption scenario the brief guards against cannot happen today.
2. **`schema-compat-install.ts`** advertises the output schemas and was not mentioned;
   updating it turned out to be required (section 6). `manifest.json` was stale (1.2.2), and
   `CHANGELOG.md` 1.2.0 claims every tool declares an `outputSchema`, which `index.ts` no
   longer does itself; the compat layer does.
3. **`AGENTS.md`** ("FTP Notes") says to always use binary mode. That is now wrong for text
   destined for VMS. I did not edit `AGENTS.md` (not asked). It needs a sentence.
4. The brief's "lone CR LF" I read as "an existing CR LF, kept as one". A lone CR (not before
   an LF) is passed through unchanged. Say so if you meant something else.
5. The brief's suggested acceptance text ("variable-length or stream record format") is met
   by variable-length; the server never produced stream.

## 9. What I would like you to look at

* **Permissions/annotations:** `download-file` is no longer `readOnlyHint` (it writes a local
  file; `destructiveHint` true because of `overwrite`). If a client auto-approves read-only
  tools, downloads will now prompt.
* **`localPath` is a local file read/write primitive** for any client that can call the tool
  (upload reads any path the server process can; download writes one; `overwrite` defaults to
  false). Documented in the README security notes. Acceptable to you?
* **Design choices to confirm:** hidden temp sibling `.<name>.mcp-part-*` in the target
  directory; `transferMode: "ascii"` allowed together with `encoding: "base64"` (converts the
  decoded bytes); `encoding` refused with `localPath`; `overwrite` refused without `localPath`.
* **Log format:** a `Mode` line now appears on every upload/download/append entry, plus
  `Local Path` / `Local Note` / `Wire Bytes` when relevant. Anything parsing the log by line
  position would notice.
* **Content path change:** content-based upload/append now stream from memory instead of a temp
  file (download-to-content still uses one). Behaviour is unchanged in tests, but it is the one
  place existing code paths were rewritten.
* **Housekeeping I did:** dated backups beside each edited file per the lab rule
  (`*.20260921-064016`, and `src/schema-compat-install.ts.20260921-070101`), hidden from git with a pattern in `.git/info/exclude` only;
  `src/ftp-client.ts.20260913-184034` left alone as told; `package-lock.json` is git-ignored
  here so `ftp-srv` is in `package.json` only. `npm install` printed blocked-install-script
  warnings for `keytar`/`ssh2`/`cpu-features`; `keytar`'s native module was already not built
  before my install (the server's existing "keychain lookup via keytar failed" warning), and I
  changed nothing about it.
* **Review order:** `src/text-mode.ts` and `src/transfer.ts` (small, self-contained), then
  `src/ftp-client.ts` (`receiveToFile`, `sendFromSource`, `withTransferType`), then the three
  tool handlers in `src/index.ts`.
