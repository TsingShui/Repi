/**
 * Pull one entry out of a ZIP, synchronously, without holding the archive.
 *
 * This is what makes `extract()` possible in a code sandbox: an APK holds native libraries
 * that only the other engine can read, and the two are only useful together if something can
 * hand the inner file over. The engine that owns the archive cannot do it (rasc reads an
 * archive, it does not write files) and neither can the other one (Kuna reads an ELF, it does
 * not unzip), so the host does it here.
 *
 * Three properties matter:
 *
 *  - **Only the entry is read.** The central directory is a few tens of KB and lives at the
 *    end; the entry's own bytes are read after that and inflated on their own. A 126 MB APK
 *    costs one directory read plus one entry, not a copy of the archive.
 *  - **It is synchronous**, because the caller is a wasm interpreter inside a worker that
 *    cannot await.
 *  - **It verifies what it hands over.** The declared size and the CRC-32 are checked, so a
 *    truncated or tampered entry fails here rather than inside the engine that consumes it.
 */
import { inflateSync } from "fflate";

/** A positioned read. The worker supplies a `Blob`-backed one; tests supply a file-backed one. */
export type ReadAt = (offset: number, length: number) => Uint8Array;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record, plus room for a comment. */
const EOCD_SEARCH = 66_000;

export interface ZipEntryRef {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function readU16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * CRC-32 (reflected, polynomial 0xEDB88320), the checksum every ZIP entry carries.
 *
 * Written out rather than taken from `fflate`, which computes it internally and does not
 * export it; the table is built once per module.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let at = 0; at < bytes.length; at += 1) {
    c = (CRC_TABLE[(c ^ (bytes[at] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The central directory, as a name → entry map. Throws when the archive is not a ZIP. */
export function readCentralDirectory(read: ReadAt, size: number): Map<string, ZipEntryRef> {
  const tail = read(Math.max(0, size - EOCD_SEARCH), Math.min(size, EOCD_SEARCH));
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (readU32(tail, at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a ZIP archive: no end-of-central-directory record");

  const count = readU16(tail, eocd + 10);
  const directorySize = readU32(tail, eocd + 12);
  const directoryOffset = readU32(tail, eocd + 16);
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || count === 0xffff) {
    throw new Error("ZIP64 archives are not supported by extract()");
  }

  const directory = read(directoryOffset, directorySize);
  const entries = new Map<string, ZipEntryRef>();
  let at = 0;
  for (let index = 0; index < count && at + 46 <= directory.length; index += 1) {
    if (readU32(directory, at) !== CENTRAL_SIGNATURE) break;
    const method = readU16(directory, at + 10);
    const compressedSize = readU32(directory, at + 20);
    const uncompressedSize = readU32(directory, at + 24);
    const nameLength = readU16(directory, at + 28);
    const extraLength = readU16(directory, at + 30);
    const commentLength = readU16(directory, at + 32);
    const localHeaderOffset = readU32(directory, at + 42);
    const name = new TextDecoder().decode(
      directory.subarray(at + 46, at + 46 + nameLength),
    );
    entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface ExtractedEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** One entry's bytes, inflated and verified. `name` may also be a unique path suffix. */
export function extractEntry(read: ReadAt, size: number, name: string): ExtractedEntry {
  const directory = readCentralDirectory(read, size);
  const direct = directory.get(name);
  const matched =
    direct ??
    (name.startsWith("/") ? directory.get(name.slice(1)) : undefined) ??
    [...directory.values()].filter((entry) => entry.name === name || entry.name.endsWith(`/${name}`))[0];
  if (!matched) throw new Error(`no entry named ${name} in the archive`);
  if (matched.name.endsWith("/")) throw new Error(`${matched.name} is a directory`);

  const header = read(matched.localHeaderOffset, 30);
  if (readU32(header, 0) !== LOCAL_SIGNATURE) {
    throw new Error(`${matched.name}: local header is missing`);
  }
  const nameLength = readU16(header, 26);
  const extraLength = readU16(header, 28);
  const dataOffset = matched.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + matched.compressedSize > size) {
    throw new Error(`${matched.name}: data runs past the end of the archive`);
  }
  const stored = read(dataOffset, matched.compressedSize);
  const bytes =
    matched.method === 8
      ? inflateSync(stored, { out: new Uint8Array(matched.uncompressedSize) })
      : matched.method === 0
        ? stored
        : (() => {
            throw new Error(`${matched.name}: compression method ${matched.method} is not supported`);
          })();

  if (bytes.length !== matched.uncompressedSize) {
    throw new Error(
      `${matched.name}: ${bytes.length} bytes, ${matched.uncompressedSize} declared`,
    );
  }
  // The CRC is a hash of the inflated bytes; a mismatch means the entry is damaged, and
  // handing it to an engine anyway would produce a parse error that blames the engine.
  const expected = readU32(read(matched.localHeaderOffset + 14, 4), 0);
  if (expected !== 0 && crc32(bytes) !== expected) {
    throw new Error(`${matched.name}: CRC-32 does not match the header`);
  }
  return { name: matched.name, bytes };
}
