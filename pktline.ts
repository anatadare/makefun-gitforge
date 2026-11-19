// pkt-line framing for the git smart HTTP protocol. A pkt-line is a 4-hex-digit
// length (the length includes the 4 header bytes) followed by that many bytes
// of payload minus the header. "0000" is a flush packet, "0001" a delimiter
// packet, "0002" a response-end packet. Sideband packets are pkt-lines whose
// first payload byte is the channel (1 = data, 2 = progress, 3 = error).

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Encode one pkt-line from a text payload (the caller includes any trailing \n). */
export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const total = payload.length + 4;
  const header = total.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

/** Encode a list of text lines as pkt-lines, then a flush packet. */
export function pktLines(lines: readonly string[]): Buffer {
  const parts: Buffer[] = lines.map((line) => pktLine(line));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Encode a sideband packet: channel byte 1, 2 or 3 followed by the data. */
export function sideband(channel: 1 | 2 | 3, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([channel]), data]);
  const total = payload.length + 4;
  const header = total.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

export type Pkt =
  | { kind: 'line'; text: string }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * A cursor over a buffer of pkt-lines. read() returns the next packet, or null
 * when the buffer is exhausted. After the first flush, whatever is left in the
 * buffer is raw data (the pack in a receive-pack request); remaining() hands it
 * back untouched.
 */
export class PktReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get exhausted(): boolean {
    return this.offset >= this.buffer.length;
  }

  /** Bytes not yet consumed, from the current cursor to the end. */
  remaining(): Buffer {
    return this.buffer.subarray(this.offset);
  }

  read(): Pkt | null {
    if (this.offset >= this.buffer.length) return null;
    if (this.offset + 4 > this.buffer.length) {
      throw new Error('truncated pkt-line header');
    }
    const header = this.buffer.toString('ascii', this.offset, this.offset + 4);
    const length = parseInt(header, 16);
    if (Number.isNaN(length)) throw new Error(`invalid pkt-line header ${header}`);
    this.offset += 4;
    if (length === 0) return { kind: 'flush' };
    if (length === 1) return { kind: 'delim' };
    if (length === 2) return { kind: 'end' };
    if (length < 4) throw new Error(`pkt-line length ${length} is too short`);
    const payloadLength = length - 4;
    if (this.offset + payloadLength > this.buffer.length) {
      throw new Error('truncated pkt-line payload');
    }
    const text = this.buffer.toString('utf8', this.offset, this.offset + payloadLength);
    this.offset += payloadLength;
    return { kind: 'line', text };
  }

  /** Read pkt-lines until a flush (exclusive) or the end; returns the line texts. */
  readSection(): string[] {
    const lines: string[] = [];
    for (;;) {
      const pkt = this.read();
      if (pkt === null || pkt.kind === 'flush') return lines;
      if (pkt.kind === 'line') lines.push(pkt.text);
      // Delimiter and end packets inside a section are ignored by callers that
      // do not need them; v2 parsing handles delim explicitly where it matters.
    }
  }
}
