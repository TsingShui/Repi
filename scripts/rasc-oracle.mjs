/**
 * The engine's own answer, for the check suite to compare against.
 *
 * The browser and Node drive the same wasm, but through different hosts: the page mounts the
 * user's `File` in a virtual filesystem inside a Worker, and this runs the module under Node's
 * WASI with the real file. If the two disagree, the browser path mangled something, and no
 * amount of reading the DOM would reveal it — the DOM would simply be showing the wrong thing
 * confidently. It is also what makes a DEX comparable: the page wraps a bare DEX in a
 * one-entry archive, and the check compares that against the same DEX inside a real one.
 *
 * Prints JSON on stdout. Reads the artifacts `npm run build:rasc` produces, so it needs no
 * Rasc checkout of its own.
 *
 *   node scripts/rasc-oracle.mjs classes fixture.apk
 *   node scripts/rasc-oracle.mjs getclass fixture.apk Lcom/example/Fixture0;
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const wasmPath = join(projectRoot, "public/rasc/rasc.wasm");
const runner = join(projectRoot, "src/vendor/rasc/wasi-run.mjs");

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: rasc-oracle.mjs <command> <file> [args…]");
  process.exit(64);
}

const file = resolve(args[1]);
if (!existsSync(wasmPath)) {
  console.error("The Rasc module is not built. Run `npm run build:rasc`.");
  process.exit(2);
}

// The archive argument is a real path: the engine is a program, so it opens the file the way
// any other command-line tool does. Node's WASI needs the tracing flag, and the module ships
// an explicit environment because the host owns the memory ceiling.
const env = { ...process.env, RASC_WASM: wasmPath };
const { stdout, stderr, status } = spawnSync(
  process.execPath,
  ["--experimental-wasi-unstable-preview1", "--no-warnings", runner, args[0], file, ...args.slice(2)],
  { maxBuffer: 1 << 30, env },
);

const text = stdout.toString("utf8");
if (status !== 0) {
  console.error(stderr.toString("utf8").trimEnd() || `the engine exited with code ${status}`);
  process.exit(status ?? 1);
}

console.log(JSON.stringify({ code: status, text }));
