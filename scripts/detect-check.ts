/**
 * Format detection, checked without a browser.
 *
 * What is left of this file's ancestor after the analysis contract went away: the adapters
 * and the mock source that used to be checked here are gone, and detection is the piece of
 * that layer the application still runs on — the agent picks its engine from it, so an APK
 * that reads as a plain archive would send an APK to the wrong engine.
 *
 *   node scripts/run-analysis-check.mjs detect-check
 */
import { detectFormat, detectFormatFromBytes } from "../src/lib/detect-format";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label} -> ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

function checkThat(label: string, condition: boolean, detail: string): void {
  if (!condition) failures += 1;
  console.log(`${ok(condition)} ${label}${detail ? `  ${detail}` : ""}`);
}

function ok(condition: boolean): string {
  return condition ? "ok  " : "FAIL";
}

/** An ELF header, enough of one for the detector. */
function elf(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  bytes[4] = 2; // 64-bit
  bytes[5] = 1; // little-endian
  bytes[16] = 2; // ET_EXEC
  bytes[18] = 0x3e; // x86-64
  return bytes;
}

/** A ZIP with the given central-directory names. Only detection reads it. */
function zipOf(names: readonly string[], fillerBytes = 0): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const directory: { name: Uint8Array; offset: number; size: number }[] = [];
  let offset = 0;

  for (const [index, name] of names.entries()) {
    const nameBytes = encoder.encode(name);
    const size = index === 0 ? fillerBytes : 0;
    const local = new Uint8Array(30 + nameBytes.length + size);
    new DataView(local.buffer).setUint32(0, 0x04034b50, true);
    new DataView(local.buffer).setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local);
    directory.push({ name: nameBytes, offset, size });
    offset += local.length;
  }

  const centralStart = offset;
  for (const entry of directory) {
    const row = new Uint8Array(46 + entry.name.length);
    const view = new DataView(row.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(42, entry.offset, true);
    row.set(entry.name, 46);
    chunks.push(row);
    offset += row.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, directory.length, true);
  endView.setUint16(10, directory.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  chunks.push(end);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ------------------------------------------------------------------- by header

check("detect: an ELF is a native binary", detectFormatFromBytes(elf()).id, "elf");
check("detect: an APK magic is enough on its own", detectFormatFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])).id, "zip");
check("detect: an empty file is unknown", detectFormatFromBytes(new Uint8Array(0)).id, "unknown");
checkThat(
  "detect: the engine follows the format",
  detectFormatFromBytes(elf()).engine === "kuna",
  `elf → ${detectFormatFromBytes(elf()).engine}`,
);

// ---------------------------------------------- by the directory, for an archive

{
  const archive = zipOf(["META-INF/com/android/build/gradle/app-metadata.properties", "AndroidManifest.xml", "classes.dex"], 6000);
  check(
    "detect: an APK-shaped archive is an APK once its directory is read",
    (await detectFormat(new File([archive], "late.apk"))).id,
    "apk",
  );
  checkThat(
    "detect: an APK goes to rasc",
    (await detectFormat(new File([archive], "late.apk"))).engine === "rasc",
    "",
  );
  check(
    "detect: and a plain archive stays an archive",
    (await detectFormat(new File([zipOf(["docs/readme.txt"])], "toolchain.zip"))).id,
    "zip",
  );
  checkThat(
    "detect: a plain archive has no engine",
    (await detectFormat(new File([zipOf(["docs/readme.txt"])], "toolchain.zip"))).engine === null,
    "",
  );
}

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log("\nall detect checks passed");
