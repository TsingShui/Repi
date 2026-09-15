/**
 * The sandbox, checked against the real engine, under Node.
 *
 * Two things this file can prove without a browser:
 *
 *  - **the shipped sandbox** (`src/lib/agent/quickjs-sandbox.ts`) really runs a program,
 *    returns what it printed, refuses a runaway loop, refuses an allocation it cannot afford,
 *    and is usable again after both — the properties a model-facing tool lives on;
 *  - **the shipped extractor** (`src/lib/analysis/archive/zip-extract.ts`) really pulls one
 *    entry out of a real APK, and only that entry.
 *
 * The engine is reached through `scripts/rasc-oracle.mjs`, which runs the same wasm under
 * Node's WASI. In the browser the engine call is a synchronous function call instead of a
 * process, which is the one difference this check cannot see.
 *
 *   APK=/path/to/app.apk node scripts/run-check.mjs sandbox-check
 */
import { spawnSync } from "node:child_process";
import { openSync, readSync, statSync, closeSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractEntry } from "../src/lib/analysis/archive/zip-extract";
import { createVfsFunctions } from "../src/lib/agent/vfs-functions";
import { Sandbox, type EngineOutcome } from "../src/lib/agent/quickjs-sandbox";

const APK = process.env.APK;
if (!APK) {
  console.log("skip: set APK=/path/to/app.apk");
  process.exit(0);
}
const apk = resolve(APK);
const projectRoot = process.env.REPI_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const ORACLE = resolve(projectRoot, "scripts/rasc-oracle.mjs");

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

/** The engine, as the sandbox sees it here: one process per call, through the oracle. */
function rasc(untyped: readonly unknown[]): EngineOutcome {
  const args = untyped.map((arg) => String(arg));
  const [command, ...rest] = args;
  if (command === undefined) throw new Error("rasc() needs a command");
  // The guest names the mount; this host runs a process per call, and the oracle wants the
  // archive as the second argument, so the mount is translated and lifted out of the line.
  const mapped = rest.map((arg) => (arg === ARCHIVE_PATH ? apk : arg));
  const at = mapped.indexOf(apk);
  const file = at === -1 ? undefined : mapped.splice(at, 1)[0];
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-wasi-unstable-preview1",
      "--no-warnings",
      ORACLE,
      command,
      ...(file === undefined ? [] : [file]),
      ...mapped,
    ],
    { maxBuffer: 1 << 30 },
  );
  const stdout = result.stdout?.toString("utf8") ?? "";
  if (result.status !== 0 || stdout.trim() === "") {
    return { stdout: "", stderr: result.stderr?.toString("utf8") ?? "", code: result.status ?? 1 };
  }
  // The oracle prints `{code, text}` so a caller can tell output from exit status.
  const parsed = JSON.parse(stdout) as { code: number; text: string };
  return { stdout: parsed.text, stderr: "", code: parsed.code };
}

// The mount is named after the file, so the check's programs name it too.
const ARCHIVE_PATH = `/work/${basename(apk)}`;
const LIMITS = { memoryBytes: 256 << 20, deadlineMs: 15_000 };
let sandbox = new Sandbox({ functions: { rasc } }, LIMITS);
/** What the page does when a run poisons the interpreter: a new Worker, not a reused one. */
const recycle = () => {
  sandbox.dispose();
  sandbox = new Sandbox({ functions: { rasc } }, LIMITS);
  return sandbox;
};
let calls = 0;
const counting: typeof rasc = (args) => {
  calls += 1;
  return rasc(args);
};
const instrumented = new Sandbox({ functions: { rasc: counting } }, LIMITS);

// ------------------------------------------------------------------ a real answer

{
  const outcome = await instrumented.run(`
    const rows = rasc(['classes', '--filter', 'Activity', '${ARCHIVE_PATH}']).stdout
      .split('\\n').filter((line) => line.length > 0);
    const byDex = {};
    for (const row of rows) { const dex = row.split(' | ')[0]; byDex[dex] = (byDex[dex] ?? 0) + 1; }
    print(JSON.stringify({ rows: rows.length }));
    return JSON.stringify({ dexes: Object.keys(byDex).length, sample: rows[0]?.slice(0, 40) ?? null });
  `);
  const result = JSON.parse(outcome.result ?? "{}") as { dexes?: number; sample?: string };
  check(
    "a program filters with the engine and returns a small answer",
    outcome.error === null && (result.dexes ?? 0) > 0 && (outcome.result?.length ?? 0) < 200,
    `${outcome.result?.length ?? 0} bytes, ${outcome.ms} ms, ${calls} engine call(s)`,
  );
  check("print() and the return value both arrive", outcome.printed.includes("rows"), outcome.printed.trim());
}

// -------------------------------------------------------------- the two refusals

{
  const outcome = await sandbox.run("while (true) {}");
  check(
    "a runaway program is interrupted, not hung",
    outcome.error?.message.includes("interrupted") === true && outcome.poisoned,
    `${outcome.ms} ms`,
  );
  const after = await recycle().run("return 1 + 1;");
  check("a recycled sandbox works after an interrupt", after.error === null && after.result === "2");
}
{
  const outcome = await sandbox.run("const a = []; for (;;) a.push(new Uint8Array(1 << 20));");
  check(
    "an allocation past the ceiling fails with a readable error",
    outcome.error?.message.includes("out of memory") === true && outcome.poisoned,
    `${outcome.ms} ms`,
  );
  const after = await recycle().run("'alive'");
  check("a recycled sandbox works after an OOM", after.error === null && after.result === "alive");
}
{
  const outcome = await sandbox.run("const x = undefined; x.split(' ');");
  check(
    "a bug in the program comes back as name, message and stack",
    outcome.error?.name === "TypeError" && outcome.error.stack !== null,
    `${outcome.error?.name}: ${outcome.error?.message}`,
  );
}
{
  const outcome = await sandbox.run("const label = 'x'; return label.toUpperCase();");
  check(
    "a top-level return works (the syntax error is retried inside a function)",
    // A string result comes back as itself; any other value is JSON-encoded.
    outcome.error === null && outcome.result === "X",
    outcome.error ? `${outcome.error.name}: ${outcome.error.message}` : `result=${JSON.stringify(outcome.result)}`,
  );
}
{
  const outcome = await sandbox.run("print('y'.repeat(200000)); 'done'");
  check("printed output is capped and says so", outcome.truncated && outcome.printed.includes("truncated"));
}

// -------------------------------------------------------------------- extract()

{
  const entries = rasc(["entries", ARCHIVE_PATH]).stdout;
  const library = entries
    .split("\n")
    .map((line) => line.split(" | ")[0]?.trim() ?? "")
    .find((name) => name.endsWith(".so") && name.includes("arm64"));
  check("the archive holds a native library to pull out", library !== undefined, library ?? "");

  if (library) {
    const fd = openSync(apk, "r");
    try {
      const size = statSync(apk).size;
      const read = (offset: number, length: number) => {
        const buffer = new Uint8Array(length);
        const got = readSync(fd, buffer, 0, length, offset);
        return buffer.subarray(0, got);
      };
      const entry = extractEntry(read, size, library);
      const magic = [...entry.bytes.subarray(0, 4)].map((b) => b.toString(16)).join(" ");
      check(
        "one entry comes out whole and verified",
        entry.bytes.length > 0 && magic.startsWith("7f 45 4c 46"),
        `${entry.name}: ${entry.bytes.length} bytes, ELF magic ${magic}`,
      );
      let threw = false;
      try {
        extractEntry(read, size, "lib/does-not-exist.so");
      } catch {
        threw = true;
      }
      check("a missing entry is an error, not an empty file", threw);
    } finally {
      closeSync(fd);
    }
  }
}

// ------------------------------------------------- the filesystem, from inside a program
//
// The rules themselves are checked in `text-files-check`; what is checked here is the part that
// only a real interpreter can answer: that a program can *call* these functions at all, in the
// sandbox the worker actually builds, with the results coming back marshalled the way a program
// receives them.
{
  const written = new Map<string, Uint8Array>();
  const shared = new Map<string, Uint8Array>([
    ["notes/prior.md", new TextEncoder().encode("from an earlier session\nsecond line\n")],
  ]);
  const withFiles = new Sandbox(
    { functions: { rasc, ...createVfsFunctions({ written, shared }) } },
    LIMITS,
  );
  try {
    const outcome = await withFiles.run(`
      const before = read('notes/prior.md');
      write('out/note.md', 'kept: ' + before.split('\\n')[1].trim());
      edit('out/note.md', 'kept:', 'saved:');
      return { before, after: read('out/note.md') };
    `);
    const result = outcome.result ?? "";
    check(
      "a program reads a file another session produced",
      result.includes("second line"),
      outcome.error ? `${outcome.error.name}: ${outcome.error.message}` : result.slice(0, 120),
    );
    check("writes one, edits it, and reads it back", result.includes("saved: second line"), result.slice(0, 160));
    check(
      "a program's read is the file's text, with no header mixed in",
      result.includes('"before":"from an earlier session') ||
        result.includes('"before":"second line'),
      result.slice(0, 120),
    );
    check(
      "and what it wrote is what the host is handed",
      new TextDecoder().decode(written.get("out/note.md") ?? new Uint8Array()) === "saved: second line",
      new TextDecoder().decode(written.get("out/note.md") ?? new Uint8Array()),
    );
  } finally {
    withFiles.dispose();
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
