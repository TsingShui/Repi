/**
 * Real DEX fixtures for the check suite, built here rather than downloaded.
 *
 * The Rasc engine refuses anything that is not a DEX inside an archive, so an
 * end-to-end check needs a real one. These are ports of the fixtures Rasc tests
 * itself with (`src/dex/mod.rs`): a class whose method holds a `const-string` and
 * returns, and two classes where one calls the other — which is what gives the
 * code view a real call site to link.
 *
 * They are built here, in the check suite, for the reason the corpus rule in the
 * Kuna and Rasc repositories exists: a fixture that lives in the repository is a
 * fixture nobody can check against its source.
 *
 * Usage (writes the files out for a manual session):
 *   node scripts/rasc-fixtures.mjs /tmp/repi-fixtures
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function writeU32(data, offset, value) {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

function writeU16(data, offset, value) {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
}

function pushUleb(out, value) {
  let remaining = value;
  for (;;) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
    if (remaining === 0) return;
  }
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let index = 12; index < bytes.length; index += 1) {
    a = (a + bytes[index]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** The checksum the decoder validates before parsing anything. */
function sealDex(out) {
  writeU32(out, 0x08, adler32(out));
  return out;
}

/**
 * `classCount` classes, each with one method whose body is
 * `const-string v0, "…"` followed by `return-void`.
 *
 * The class count is the knob that decides how big the index is, so the same
 * fixture covers a small tree and a long one.
 */
export function constStringDex({ classCount = 3, packageName = "com/example", value = "Authorization" } = {}) {
  const headerSize = 0x70;
  const prefix = packageName ? `${packageName}/` : "";
  const strings = [value];
  for (let index = 0; index < classCount; index += 1) strings.push(`L${prefix}Fixture${index};`);
  for (let index = 0; index < classCount; index += 1) strings.push(`m${index}`);
  strings.splice(classCount + 1, 0, "V");

  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + strings.length * 4;
  const protoIdsOff = typeIdsOff + (classCount + 2) * 4;
  const methodIdsOff = protoIdsOff + 12;
  const classDefsOff = methodIdsOff + classCount * 8;
  const dataOff = classDefsOff + classCount * 32;

  const data = [];
  const stringOffsets = [];
  for (const text of strings) {
    stringOffsets.push(dataOff + data.length);
    pushUleb(data, text.length);
    for (const character of text) data.push(character.charCodeAt(0));
    data.push(0);
  }

  const classDataOffsets = [];
  for (let index = 0; index < classCount; index += 1) {
    while ((dataOff + data.length) % 4 !== 0) data.push(0);
    const codeOff = dataOff + data.length;
    data.push(1, 0); // registers_size: v0
    data.push(0, 0); // ins_size
    data.push(0, 0); // outs_size
    data.push(0, 0); // tries_size
    data.push(0, 0, 0, 0); // debug_info_off
    data.push(3, 0, 0, 0); // insns_size, in code units
    data.push(0x1a, 0x00, 0x00, 0x00); // const-string v0, #0
    data.push(0x0e, 0x00); // return-void

    classDataOffsets.push(dataOff + data.length);
    data.push(0); // static_fields_size
    data.push(0); // instance_fields_size
    data.push(1); // direct_methods_size
    data.push(0); // virtual_methods_size
    pushUleb(data, index); // method_idx_diff
    pushUleb(data, 0); // access_flags
    pushUleb(data, codeOff);
  }

  const total = dataOff + data.length;
  const out = new Uint8Array(total);
  out.set([..."dex\n039\0"].map((character) => character.charCodeAt(0)), 0);
  writeU32(out, 0x20, total);
  writeU32(out, 0x24, headerSize);
  writeU32(out, 0x28, 0x12345678);
  writeU32(out, 0x38, strings.length);
  writeU32(out, 0x3c, stringIdsOff);
  writeU32(out, 0x40, classCount + 2);
  writeU32(out, 0x44, typeIdsOff);
  writeU32(out, 0x48, 1);
  writeU32(out, 0x4c, protoIdsOff);
  writeU32(out, 0x58, classCount);
  writeU32(out, 0x5c, methodIdsOff);
  writeU32(out, 0x60, classCount);
  writeU32(out, 0x64, classDefsOff);

  for (let index = 0; index < stringOffsets.length; index += 1) {
    writeU32(out, stringIdsOff + index * 4, stringOffsets[index]);
  }
  writeU32(out, typeIdsOff, 0);
  writeU32(out, typeIdsOff + (classCount + 1) * 4, classCount + 1);
  writeU32(out, protoIdsOff, classCount + 1);
  writeU32(out, protoIdsOff + 4, classCount + 1);
  writeU32(out, protoIdsOff + 8, 0);

  for (let index = 0; index < classCount; index += 1) {
    writeU32(out, typeIdsOff + (index + 1) * 4, index + 1);
    const method = methodIdsOff + index * 8;
    writeU16(out, method, index + 1);
    writeU16(out, method + 2, 0);
    writeU32(out, method + 4, classCount + 2 + index);
    const classDef = classDefsOff + index * 32;
    writeU32(out, classDef, index + 1);
    writeU32(out, classDef + 4, 1);
    writeU32(out, classDef + 8, 0xffffffff);
    writeU32(out, classDef + 16, 0xffffffff);
    writeU32(out, classDef + 24, classDataOffsets[index]);
  }

  out.set(data, dataOff);
  return sealDex(out);
}

/**
 * Two classes: `Alpha.target(int × 8)` has no body, and `Beta.call()` calls it
 * with eight `const/4` operands.
 *
 * The eight registers are the point. They exercise the `/range` invocation form,
 * which is where a decoder that only keeps the five inline registers loses
 * arguments — and they are what the code view gets to display and link. The call
 * crosses classes, so the link target is a different tab.
 */
export function callsDex({ packageName = "com/example" } = {}) {
  const headerSize = 0x70;
  const prefix = packageName ? `${packageName}/` : "";
  const strings = [`L${prefix}Alpha;`, `L${prefix}Beta;`, "V", "VIIIIIIII", "call", "target", "I"];

  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + strings.length * 4;
  const protoIdsOff = typeIdsOff + 4 * 4;
  const methodIdsOff = protoIdsOff + 2 * 12;
  const classDefsOff = methodIdsOff + 2 * 8;
  const dataOff = classDefsOff + 2 * 32;

  const data = [];
  const stringOffsets = [];
  for (const text of strings) {
    stringOffsets.push(dataOff + data.length);
    pushUleb(data, text.length);
    for (const character of text) data.push(character.charCodeAt(0));
    data.push(0);
  }

  while ((dataOff + data.length) % 4 !== 0) data.push(0);
  const typeListOff = dataOff + data.length;
  data.push(8, 0, 0, 0); // eight parameters
  for (let index = 0; index < 8; index += 1) data.push(3, 0); // `I`

  while ((dataOff + data.length) % 4 !== 0) data.push(0);
  const codeOff = dataOff + data.length;
  data.push(9, 0); // registers_size: v0..v8
  data.push(0, 0); // ins_size
  data.push(8, 0); // outs_size
  data.push(0, 0); // tries_size
  data.push(0, 0, 0, 0); // debug_info_off
  data.push(12, 0, 0, 0); // insns_size
  for (let register = 1; register <= 8; register += 1) {
    data.push(0x12 | ((register << 8) & 0xff00), ((register >> 4) & 0xf) | ((register - 1) << 4)); // const/4 vN, #(N-1)
  }
  data.push(0x77, 0x08); // invoke-static/range, count 8
  data.push(0, 0); // method@0, Alpha.target
  data.push(1, 0); // first register v1
  data.push(0x0e, 0x00); // return-void

  const callerDataOff = dataOff + data.length;
  data.push(0); // static_fields_size
  data.push(0); // instance_fields_size
  data.push(1); // direct_methods_size
  data.push(0); // virtual_methods_size
  pushUleb(data, 1); // method_idx_diff: Beta.call is method 1
  pushUleb(data, 0x9); // ACC_PUBLIC | ACC_STATIC
  pushUleb(data, codeOff);

  const total = dataOff + data.length;
  const out = new Uint8Array(total);
  out.set([..."dex\n039\0"].map((character) => character.charCodeAt(0)), 0);
  writeU32(out, 0x20, total);
  writeU32(out, 0x24, headerSize);
  writeU32(out, 0x28, 0x12345678);
  writeU32(out, 0x38, strings.length);
  writeU32(out, 0x3c, stringIdsOff);
  writeU32(out, 0x40, 4);
  writeU32(out, 0x44, typeIdsOff);
  writeU32(out, 0x48, 2);
  writeU32(out, 0x4c, protoIdsOff);
  writeU32(out, 0x58, 2);
  writeU32(out, 0x5c, methodIdsOff);
  writeU32(out, 0x60, 2);
  writeU32(out, 0x64, classDefsOff);

  for (let index = 0; index < stringOffsets.length; index += 1) {
    writeU32(out, stringIdsOff + index * 4, stringOffsets[index]);
  }
  // Alpha, Beta, void, int
  writeU32(out, typeIdsOff, 0);
  writeU32(out, typeIdsOff + 4, 1);
  writeU32(out, typeIdsOff + 8, 2);
  writeU32(out, typeIdsOff + 12, 6);
  // ()V and (IIIIIIII)V
  writeU32(out, protoIdsOff, 2);
  writeU32(out, protoIdsOff + 4, 2);
  writeU32(out, protoIdsOff + 8, 0);
  writeU32(out, protoIdsOff + 12, 3);
  writeU32(out, protoIdsOff + 16, 2);
  writeU32(out, protoIdsOff + 20, typeListOff);
  // Alpha.target(IIIIIIII)V, Beta.call()V
  writeU16(out, methodIdsOff, 0);
  writeU16(out, methodIdsOff + 2, 1);
  writeU32(out, methodIdsOff + 4, 5);
  writeU16(out, methodIdsOff + 8, 1);
  writeU16(out, methodIdsOff + 10, 0);
  writeU32(out, methodIdsOff + 12, 4);

  writeU32(out, classDefsOff, 0);
  writeU32(out, classDefsOff + 4, 1);
  writeU32(out, classDefsOff + 8, 0xffffffff);
  writeU32(out, classDefsOff + 16, 0xffffffff);
  writeU32(out, classDefsOff + 32, 1);
  writeU32(out, classDefsOff + 36, 1);
  writeU32(out, classDefsOff + 40, 0xffffffff);
  writeU32(out, classDefsOff + 48, 0xffffffff);
  writeU32(out, classDefsOff + 56, callerDataOff);

  out.set(data, dataOff);
  return sealDex(out);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** A STORE-only ZIP. Rasc reads the central directory and copies a stored entry. */
export function makeArchive(files) {
  const encoder = new TextEncoder();
  const entries = files.map(([name, data]) => ({
    name: encoder.encode(name),
    bytes: data,
    crc: crc32(data),
  }));

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const local = new Uint8Array(30 + entry.name.length + entry.bytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    local.set(entry.bytes, 30 + entry.name.length);
    chunks.push(local);
    central.push({ entry, offset });
    offset += local.length;
  }

  const centralStart = offset;
  for (const { entry, offset: at } of central) {
    const row = new Uint8Array(46 + entry.name.length);
    const view = new DataView(row.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.bytes.length, true);
    view.setUint32(24, entry.bytes.length, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(42, at, true);
    row.set(entry.name, 46);
    chunks.push(row);
    offset += row.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  chunks.push(end);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The same DEX inside a real archive: what the oracle is pointed at. */
export function apkOf(dex) {
  return makeArchive([
    ["AndroidManifest.xml", new TextEncoder().encode("<manifest />")],
    ["classes.dex", dex],
  ]);
}

/**
 * The same DEX inside an archive whose first entry is not the manifest.
 *
 * Gradle-built APKs really do start with `META-INF/…`, and that is what made a
 * real 61 MB APK look like a plain ZIP: the markers were not in the first four
 * kilobytes. The filler puts the manifest past that, so the check exercises the
 * directory read rather than the prefix.
 */
export function apkWithLeadingEntry(dex) {
  const filler = new Uint8Array(6000).fill(0x20);
  return makeArchive([
    ["META-INF/com/android/build/gradle/app-metadata.properties", filler],
    ["AndroidManifest.xml", new TextEncoder().encode("<manifest />")],
    ["classes.dex", dex],
  ]);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const destination = resolve(process.argv[2] ?? ".");
  const classes = constStringDex({ classCount: 4 });
  const calls = callsDex();
  writeFileSync(join(destination, "classes.dex"), classes);
  writeFileSync(join(destination, "classes.apk"), apkOf(classes));
  writeFileSync(join(destination, "calls.dex"), calls);
  writeFileSync(join(destination, "calls.apk"), apkOf(calls));
  console.log(`wrote classes.dex, classes.apk, calls.dex, calls.apk to ${destination}`);
}
