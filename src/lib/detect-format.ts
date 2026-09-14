/**
 * Local format detection.
 *
 * Everything here reads bytes the browser already handed us. No part of this
 * module performs a network request, and no file content ever leaves the page.
 */

export type FormatId = "elf" | "pe" | "macho" | "macho-fat" | "dex" | "apk" | "zip" | "unknown";

/** Analysis engine that will eventually handle this file. */
export type EngineId = "kuna" | "rasc";

export interface FormatMatch {
  readonly id: FormatId;
  readonly label: string;
  /** `null` when Repi has no engine for the container yet. */
  readonly engine: EngineId | null;
  /** Short architecture or container note, for example `AArch64`. */
  readonly detail: string;
}

/** Longest header we ever need: PE needs the DOS stub plus the COFF header. */
const HEADER_BYTES = 4096;

const ELF_MACHINES: Readonly<Record<number, string>> = {
  0x0003: "x86",
  0x0008: "MIPS",
  0x0014: "PowerPC",
  0x0016: "s390",
  0x0028: "ARM",
  0x003e: "x86-64",
  0x00b7: "AArch64",
  0x00f3: "RISC-V",
};

const PE_MACHINES: Readonly<Record<number, string>> = {
  0x014c: "x86",
  0x01c0: "ARM",
  0x01c4: "ARMv7",
  0x8664: "x86-64",
  0xaa64: "AArch64",
};

const MACHO_CPUS: Readonly<Record<number, string>> = {
  7: "x86",
  12: "ARM",
  0x01000007: "x86-64",
  0x0100000c: "AArch64",
};

const ELF_ENGINE: EngineId = "kuna";
const ANDROID_ENGINE: EngineId = "rasc";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}


function matches(bytes: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  if (bytes.length < offset + pattern.length) return false;
  return pattern.every((byte, index) => bytes[offset + index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string | null {
  if (bytes.length < offset + length) return null;
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) return null;
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text.length > 0 ? text : null;
}

function containsAscii(haystack: Uint8Array, needle: string): boolean {
  const target = [...needle].map((character) => character.charCodeAt(0));
  const last = haystack.length - target.length;
  for (let start = 0; start <= last; start += 1) {
    if (matches(haystack, start, target)) return true;
  }
  return false;
}

function readUint16(view: DataView, offset: number, littleEndian: boolean): number | null {
  if (offset + 2 > view.byteLength) return null;
  return view.getUint16(offset, littleEndian);
}

function readUint32(view: DataView, offset: number, littleEndian: boolean): number | null {
  if (offset + 4 > view.byteLength) return null;
  return view.getUint32(offset, littleEndian);
}

function detectElf(bytes: Uint8Array, view: DataView): FormatMatch {
  const is64Bit = bytes[4] === 2;
  const littleEndian = bytes[5] !== 2;
  const machine = readUint16(view, 18, littleEndian);
  const architecture = machine === null ? "unknown" : (ELF_MACHINES[machine] ?? "unknown");

  return {
    id: "elf",
    label: `ELF ${is64Bit ? "64-bit" : "32-bit"}`,
    engine: ELF_ENGINE,
    detail: architecture,
  };
}

function detectPe(bytes: Uint8Array, view: DataView): FormatMatch | null {
  const coffOffset = readUint32(view, 0x3c, true);
  if (coffOffset === null || !matches(bytes, coffOffset, [0x50, 0x45, 0x00, 0x00])) return null;

  const machine = readUint16(view, coffOffset + 4, true);
  const architecture = machine === null ? "unknown" : (PE_MACHINES[machine] ?? "unknown");

  return {
    id: "pe",
    label: "PE",
    engine: ELF_ENGINE,
    detail: architecture,
  };
}

function detectMacho(bytes: Uint8Array, view: DataView): FormatMatch | null {
  // A fat binary stores several thin Mach-O slices side by side.
  if (matches(bytes, 0, [0xca, 0xfe, 0xba, 0xbe])) {
    const count = readUint32(view, 4, false);
    return {
      id: "macho-fat",
      label: "Mach-O universal",
      engine: ELF_ENGINE,
      detail: count === null ? "multi-architecture" : `${count} slices`,
    };
  }

  const littleEndian = matches(bytes, 0, [0xce, 0xfa, 0xed, 0xfe]) || matches(bytes, 0, [0xcf, 0xfa, 0xed, 0xfe]);
  const thin = littleEndian || matches(bytes, 0, [0xfe, 0xed, 0xfa, 0xce]) || matches(bytes, 0, [0xfe, 0xed, 0xfa, 0xcf]);
  if (!thin) return null;

  const is64Bit = matches(bytes, 0, [0xcf, 0xfa, 0xed, 0xfe]) || matches(bytes, 0, [0xfe, 0xed, 0xfa, 0xcf]);
  const cpuType = readUint32(view, 4, littleEndian);
  // The CPU type is unsigned in the file, but signed reads are simpler to map.
  const signed = cpuType === null ? null : cpuType | 0;
  const architecture = signed === null ? "unknown" : (MACHO_CPUS[signed >>> 0] ?? "unknown");

  return {
    id: "macho",
    label: `Mach-O ${is64Bit ? "64-bit" : "32-bit"}`,
    engine: ELF_ENGINE,
    detail: architecture,
  };
}

function detectDex(bytes: Uint8Array): FormatMatch {
  const version = asciiAt(bytes, 4, 3);
  return {
    id: "dex",
    label: "DEX",
    engine: ANDROID_ENGINE,
    detail: version === null ? "Dalvik bytecode" : `bytecode v${version.trim()}`,
  };
}

function detectZip(bytes: Uint8Array): FormatMatch {
  // APK archives always carry a manifest, and usually Dalvik bytecode. The
  // markers may be in the bytes at hand even when they are not in the front of
  // the file, so a whole buffer is asked first and its directory second.
  if (containsAscii(bytes, "AndroidManifest.xml") || containsAscii(bytes, "classes.dex")) {
    return androidOrArchive(true);
  }
  return androidOrArchive(zipEntryNames(bytes).some(isAndroidEntry));
}

function androidOrArchive(isAndroid: boolean): FormatMatch {
  if (isAndroid) {
    return {
      id: "apk",
      label: "APK",
      engine: ANDROID_ENGINE,
      detail: "Android package",
    };
  }

  return {
    id: "zip",
    label: "ZIP archive",
    engine: null,
    detail: "archive only",
  };
}

const EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const CENTRAL_SIGNATURE = [0x50, 0x4b, 0x01, 0x02];
/** The end-of-directory record, plus the longest comment that may follow it. */
const EOCD_SEARCH_BYTES = 65_557;
/**
 * How much of the central directory is read looking for the markers.
 *
 * It is read from the front, where the entries a build tool writes first sit -
 * a manifest and the DEX files. Four megabytes covers tens of thousands of
 * entries, which is past every real archive.
 */
const DIRECTORY_WINDOW = 4 << 20;
const DIRECTORY_NAME_LIMIT = 20_000;

function lastIndexOf(haystack: Uint8Array, needle: readonly number[]): number {
  const last = haystack.length - needle.length;
  for (let start = last; start >= 0; start -= 1) {
    if (matches(haystack, start, needle)) return start;
  }
  return -1;
}

/** Walks a central directory from `start`, reading names for up to `size` bytes. */
function centralDirectoryNames(directory: Uint8Array, start: number, size: number): string[] {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const names: string[] = [];
  let offset = start;
  const end = Math.min(start + size, directory.byteLength);

  while (offset + 46 <= end && names.length < DIRECTORY_NAME_LIMIT) {
    if (!matches(directory, offset, CENTRAL_SIGNATURE)) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const from = offset + 46;
    const name = new TextDecoder().decode(directory.subarray(from, Math.min(from + nameLength, end)));
    names.push(name);
    offset = from + nameLength + extraLength + commentLength;
  }

  return names;
}

/** Whether an entry name says this archive is an Android package. */
function isAndroidEntry(name: string): boolean {
  return name === "AndroidManifest.xml" || (name.endsWith(".dex") && !name.includes("/"));
}

/**
 * The names in a ZIP's central directory, from a buffer that holds all of it.
 *
 * Empty when the buffer holds no end-of-directory record, which is what a leading
 * slice of a file looks like: a prefix has the local entries but not the
 * directory, and that is exactly why detection does not stop at a prefix.
 */
function zipEntryNames(bytes: Uint8Array): string[] {
  const eocd = lastIndexOf(bytes, EOCD_SIGNATURE);
  if (eocd === -1 || eocd + 22 > bytes.byteLength) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return centralDirectoryNames(bytes, view.getUint32(eocd + 16, true), view.getUint32(eocd + 12, true));
}

/**
 * The same question asked of a file, reading only the two ranges that answer it.
 *
 * **A prefix is not enough.** The first four kilobytes of an APK hold whatever
 * entry the build tool wrote first, and that is not always the manifest: a
 * Gradle-built archive can start with `META-INF/…`, and this check used to call
 * those files plain ZIP archives and refuse them. The names that identify an
 * Android package live in the central directory, so that is what is read.
 */
async function fileIsAndroidPackage(file: File): Promise<boolean> {
  const tailStart = Math.max(0, file.size - EOCD_SEARCH_BYTES);
  const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer());
  const eocd = lastIndexOf(tail, EOCD_SIGNATURE);
  if (eocd === -1) return false;

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const wanted = Math.min(directorySize, DIRECTORY_WINDOW);
  if (wanted === 0) return false;

  const directory = new Uint8Array(
    await file.slice(directoryOffset, Math.min(directoryOffset + wanted, file.size)).arrayBuffer(),
  );
  return centralDirectoryNames(directory, 0, directory.byteLength).some(isAndroidEntry);
}

export function detectFormatFromBytes(bytes: Uint8Array): FormatMatch {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (matches(bytes, 0, [0x7f, 0x45, 0x4c, 0x46])) return detectElf(bytes, view);
  if (matches(bytes, 0, [0x64, 0x65, 0x78, 0x0a])) return detectDex(bytes);
  if (matches(bytes, 0, [0x4d, 0x5a])) {
    const pe = detectPe(bytes, view);
    if (pe) return pe;
  }

  const macho = detectMacho(bytes, view);
  if (macho) return macho;

  if (matches(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) || matches(bytes, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return detectZip(bytes);
  }

  return {
    id: "unknown",
    label: "Unrecognized",
    engine: null,
    detail: "unknown header",
  };
}

/** Reads the leading bytes of the file, then the archive's directory when needed. */
export async function detectFormat(file: File): Promise<FormatMatch> {
  const header = file.slice(0, Math.min(HEADER_BYTES, file.size));
  const buffer = await header.arrayBuffer();
  const match = detectFormatFromBytes(new Uint8Array(buffer));
  if (match.id !== "zip") return match;

  // The prefix said "archive" but not which kind. The directory is the only
  // place that knows, and reading it is two slices rather than the whole file.
  return (await fileIsAndroidPackage(file)) ? androidOrArchive(true) : match;
}

