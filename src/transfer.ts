/**
 * Shared pieces for streaming transfers between a local file and a remote
 * server: the transfer-mode type, the result shape, local path handling, and
 * the "download to a temporary sibling, then move into place" protocol that
 * gives the overwrite guarantee.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

export type TransferMode = "binary" | "ascii";

/**
 * What a transfer measured. Byte counts and the hash are always those of the
 * LOCAL side: in ASCII mode the wire and remote sizes legitimately differ
 * from the local file's, so `wireBytes` (FTP only) reports the other figure.
 */
export interface LocalTransferResult {
  localBytes: number;
  sha256: string;
  wireBytes?: number;
  transferMode: TransferMode;
  /** Absolute path used, for localPath transfers. */
  localPath?: string;
}

/** Absolute paths are used as given; `~` and `~/x` expand to the home directory; anything else is relative to the server's working directory. */
export function resolveLocalPath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error("localPath must not be empty");
  if (input.includes("\0")) throw new Error("localPath must not contain NUL characters");
  let p = input;
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/** Resolve a local file to be sent and check that it can be: it must exist and be a regular file. */
export function requireLocalSource(input: string): string {
  const resolved = resolveLocalPath(input);
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch (err: any) {
    throw new Error(`Local file ${resolved} cannot be read: ${err?.code === "ENOENT" ? "no such file" : err?.message ?? err}`);
  }
  if (!st.isFile()) throw new Error(`Local path ${resolved} is not a regular file`);
  return resolved;
}

export interface DownloadTarget {
  /** Final absolute path. */
  target: string;
  /** Where the bytes are written first: a hidden sibling, so a failed transfer never leaves a partial file at `target`. */
  temp: string;
}

/**
 * Validate a download destination before any connection is made. Refuses to
 * replace an existing file unless `overwrite`, and never creates directories.
 */
export function prepareDownloadTarget(input: string, overwrite: boolean): DownloadTarget {
  const target = resolveLocalPath(input);
  const dir = path.dirname(target);
  let dirStat: fs.Stats | undefined;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    /* reported below */
  }
  if (!dirStat?.isDirectory()) {
    throw new Error(`Local directory ${dir} does not exist (directories are not created implicitly)`);
  }
  const existing = (() => {
    try {
      return fs.lstatSync(target);
    } catch {
      return undefined;
    }
  })();
  if (existing) {
    if (existing.isDirectory()) throw new Error(`Local path ${target} is a directory`);
    if (!overwrite) {
      throw new Error(`Local file ${target} already exists. Pass overwrite: true to replace it.`);
    }
  }
  return { target, temp: path.join(dir, `.${path.basename(target)}.mcp-part-${randomUUID().slice(0, 8)}`) };
}

/** Move a finished download into place. Without `overwrite` this fails rather than replace a file that appeared meanwhile. */
export function commitDownload({ target, temp }: DownloadTarget, overwrite: boolean): void {
  if (overwrite) {
    fs.renameSync(temp, target);
    return;
  }
  try {
    fs.linkSync(temp, target); // fails with EEXIST instead of replacing
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      throw new Error(`Local file ${target} already exists. Pass overwrite: true to replace it.`);
    }
    // Filesystems without hard links: fall back to an exclusive copy, which also refuses to replace.
    try {
      fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
    } catch (copyErr: any) {
      if (copyErr?.code === "EEXIST") {
        throw new Error(`Local file ${target} already exists. Pass overwrite: true to replace it.`);
      }
      throw copyErr;
    }
  }
  fs.unlinkSync(temp);
}

export function discardTemp(temp: string): void {
  try {
    fs.unlinkSync(temp);
  } catch {
    /* already gone */
  }
}

/** Stream a file through SHA-256 without reading it into memory. */
export async function hashLocalFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}
