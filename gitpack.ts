// Git objects and packfiles, in pure TypeScript on Node built-ins.
// An object id is SHA-1 over "<type> <byte length>\0" + the content bytes.
// Packfiles are PACK v2: "PACK", version 2, object count, then entries of a
// type/size varint header plus a zlib stream, then a SHA-1 trailer over all
// preceding bytes. Deltas (OFS_DELTA, REF_DELTA) are resolved against bases
// already read from the same pack or supplied by the caller.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SHA40 = /^[0-9a-f]{40}$/;

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The object id of a (type, content) pair. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Build an object record, computing its id. */
export function makeObject(type: ObjectType, data: Buffer): GitObject {
  return { oid: hashObject(type, data), type, data };
}

// ---------------------------------------------------------------- commits

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Committer time as epoch seconds (0 when the line does not parse). */
  committerTime: number;
  message: string;
}

/** Parse a commit object. Headers are "key value" lines; the message follows a blank line. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  let committerTime = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      const match = /,? (\d+) [+-]\d{4}$/.exec(committer) ?? / (\d+) [+-]\d{4}$/.exec(committer);
      if (match !== null) committerTime = Number(match[1]);
    }
  }
  return { tree, parents, author, committer, committerTime, message };
}

/** Serialize a commit object from its fields. */
export function buildCommit(commit: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** A "Name <email> epoch +0000" identity line for a commit header. */
export function identityLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object: entries are "<mode> <name>\0" + 20 raw oid bytes. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1 || nul + 21 > data.length) {
      throw new Error('malformed tree object');
    }
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Sort key for git tree order: names sort byte-wise, directories as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries in git order (directories sort as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------- tags

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ------------------------------------------------------------------ packs

/** Apply a git delta stream to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if ((opcode & 0x80) !== 0) {
      // Copy from the base: offset/size bytes follow the bitmask.
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy');
          copyOffset |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy');
          copySize |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (opcode !== 0) {
      // Insert the next `opcode` literal bytes.
      if (offset + opcode > delta.length) throw new Error('truncated delta insert');
      chunks.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      written += opcode;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  const result = Buffer.concat(chunks);
  if (result.length !== targetSize || written !== targetSize) {
    throw new Error('delta target size mismatch');
  }
  return result;
}

export interface PackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/**
 * Parse a PACK v2 buffer into its objects. Deltas resolve against bases in the
 * same pack (read earlier or later) or, for REF_DELTA, against objects the
 * caller can supply (the repo's store). The trailer checksum is verified.
 */
export function readPack(
  pack: Buffer,
  baseResolver?: (oid: string) => GitObject | undefined,
): PackEntry[] {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expectedTrailer = pack.subarray(pack.length - 20).toString('hex');
  const actualTrailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');

  // First pass: read every entry's header and zlib payload.
  interface RawEntry {
    offset: number;
    code: number;
    size: number;
    baseOffset?: number;
    baseOid?: string;
    payload: Buffer;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    if (offset >= pack.length - 20) throw new Error('pack ends before all objects are read');
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= pack.length - 20) throw new Error('truncated pack object header');
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) {
      // OFS_DELTA: negative offset from this entry's start.
      if (offset >= pack.length - 20) throw new Error('truncated ofs-delta offset');
      byte = pack[offset];
      offset += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= pack.length - 20) throw new Error('truncated ofs-delta offset');
        byte = pack[offset];
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (code === 7) {
      // REF_DELTA: 20-byte base oid.
      if (offset + 20 > pack.length - 20) throw new Error('truncated ref-delta base');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[code] === undefined) {
      throw new Error(`unknown pack object type code ${code}`);
    }
    // The zlib stream is self-terminating but its end is not marked; find it by
    // binary search (inflateSync ignores trailing bytes and throws on a
    // truncated stream, so "this prefix inflates to the expected size" is
    // monotone in the end offset).
    const payload = inflateBounded(pack, offset, pack.length - 20, size);
    offset = payload.endOffset;
    const entry: RawEntry = { offset: start, code, size, baseOffset, baseOid, payload: payload.data };
    raw.push(entry);
    byOffset.set(start, entry);
  }

  // Second pass: resolve deltas (bases may appear after their deltas).
  const resolved = new Map<number, PackEntry>();
  const resolve = (entry: RawEntry, depth: number): PackEntry => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (depth > 64) throw new Error('delta chain too deep');
    if (entry.code === 6 || entry.code === 7) {
      let base: PackEntry | GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base offset is out of range');
        base = resolve(baseEntry, depth + 1);
      } else if (entry.baseOid !== undefined) {
        base = baseResolver?.(entry.baseOid);
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is unknown`);
      }
      if (base === undefined) throw new Error('delta has no base');
      const data = applyDelta(base.data, entry.payload);
      if (data.length !== entry.size) throw new Error('delta result size mismatch');
      const resolvedEntry: PackEntry = { oid: hashObject(base.type, data), type: base.type, data };
      resolved.set(entry.offset, resolvedEntry);
      return resolvedEntry;
    }
    const type = CODE_TYPE[entry.code];
    const resolvedEntry: PackEntry = { oid: hashObject(type, entry.payload), type, data: entry.payload };
    resolved.set(entry.offset, resolvedEntry);
    return resolvedEntry;
  };
  return raw.map((entry) => resolve(entry, 0));
}

/** Adler-32, the checksum a zlib stream ends with (big-endian, 4 bytes). */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate a zlib stream that starts at `start` inside `pack` and ends before
 * `limit`, returning its data and the offset just past the stream. inflateSync
 * ignores bytes past the stream's end, so one call yields the data; the stream
 * ends with the Adler-32 of that data, and the first occurrence of those four
 * bytes after the two-byte header is the stream's end.
 */
function inflateBounded(
  pack: Buffer,
  start: number,
  limit: number,
  expectedSize: number,
): { data: Buffer; endOffset: number } {
  let data: Buffer;
  try {
    data = inflateSync(pack.subarray(start, limit));
  } catch {
    throw new Error('zlib stream does not inflate');
  }
  if (data.length !== expectedSize) throw new Error('zlib stream does not inflate to its declared size');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  // The first occurrence of the checksum that inflates cleanly as a prefix is
  // the stream's end: an earlier coincidental match ends mid-stream, and
  // inflating that prefix throws (truncated), so it is skipped.
  let found = pack.indexOf(needle, start + 2);
  while (found !== -1 && found + 4 <= limit) {
    try {
      const check = inflateSync(pack.subarray(start, found + 4));
      if (check.length === expectedSize) return { data, endOffset: found + 4 };
    } catch {
      // Not the end; keep searching past this match.
    }
    found = pack.indexOf(needle, found + 1);
  }
  throw new Error('zlib stream end could not be determined');
}

/** Serialize objects as a PACK v2 with plain (non-delta) entries, sorted by oid. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const object of sorted) {
    const compressed = deflateSync(object.data);
    const typeCode = TYPE_CODE[object.type];
    // Object header: first byte holds the type in bits 4-6 and the low 4 bits
    // of the size; continuation bytes carry 7 size bits each.
    let size = object.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      headerBytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    headerBytes.push(first);
    parts.push(Buffer.from(headerBytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

