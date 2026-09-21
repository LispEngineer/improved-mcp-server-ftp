/**
 * Streaming line-ending converters for FTP ASCII mode (RFC 959, TYPE A).
 *
 * In ASCII mode the wire form of a line ending is CR LF. basic-ftp sends
 * `TYPE A` if asked but converts nothing, so the client must: local LF ->
 * wire CR LF on upload, wire CR LF -> local LF on download.
 *
 * Both converters are stateful so a CR at the end of one chunk and an LF at
 * the start of the next are treated as the pair they are. A lone CR (not
 * followed by LF) is data and is passed through unchanged in both directions.
 */

const CR = 0x0d;
const LF = 0x0a;
const CR_BUF = Buffer.from([CR]);
const EMPTY = Buffer.alloc(0);

/** Upload direction: LF -> CR LF. An LF that already follows a CR is left alone. */
export class LfToCrlf {
  private prevWasCR = false;

  convert(chunk: Buffer): Buffer {
    if (chunk.length === 0) return chunk;
    let parts: Buffer[] | null = null;
    let start = 0;
    for (let i = chunk.indexOf(LF); i !== -1; i = chunk.indexOf(LF, i + 1)) {
      const followsCR = i === 0 ? this.prevWasCR : chunk[i - 1] === CR;
      if (!followsCR) {
        (parts ??= []).push(chunk.subarray(start, i), CR_BUF);
        start = i; // the LF itself goes out with the next slice
      }
    }
    this.prevWasCR = chunk[chunk.length - 1] === CR;
    if (parts === null) return chunk;
    parts.push(chunk.subarray(start));
    return Buffer.concat(parts);
  }
}

/** Download direction: CR LF -> LF. A CR ending a chunk is held until the next chunk shows whether an LF follows. */
export class CrlfToLf {
  private pendingCR = false;

  convert(chunk: Buffer): Buffer {
    if (chunk.length === 0) return EMPTY;
    const parts: Buffer[] = [];
    if (this.pendingCR) {
      this.pendingCR = false;
      if (chunk[0] !== LF) parts.push(CR_BUF); // it was a lone CR after all
    }
    let start = 0;
    for (let i = chunk.indexOf(CR); i !== -1; i = chunk.indexOf(CR, i + 1)) {
      if (i === chunk.length - 1) {
        parts.push(chunk.subarray(start, i));
        this.pendingCR = true;
        start = chunk.length;
        break;
      }
      if (chunk[i + 1] === LF) {
        parts.push(chunk.subarray(start, i)); // drop this CR, keep the LF
        start = i + 1;
      }
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** Call once at end of stream: a CR still being held was a lone CR and is data. */
  flush(): Buffer {
    if (!this.pendingCR) return EMPTY;
    this.pendingCR = false;
    return CR_BUF;
  }
}
