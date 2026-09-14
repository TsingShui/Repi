/**
 * The engine's own answer, for the check suite to compare against.
 *
 * The browser and Node drive the same wasm, but through different hosts: the
 * page uses a JavaScript WASI shim in a Worker, and this uses Node's built-in
 * WASI. If the two disagree, the browser path mangled something, and no amount
 * of reading the DOM would reveal it — the DOM would simply be showing the wrong
 * thing confidently.
 *
 * Prints JSON on stdout. Reads the artifacts `npm run build:kuna` produces, so
 * it needs no Kuna checkout of its own.
 *
 *   node scripts/kuna-oracle.mjs list sample.elf
 *   node scripts/kuna-oracle.mjs decompile sample.elf main
 *   node scripts/kuna-oracle.mjs decompile sample.elf 0x1198
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const kunaDir = join(projectRoot, "public/kuna");

const [command, fixture, target] = process.argv.slice(2);

if (!command || !fixture) {
  console.error("usage: kuna-oracle.mjs <list|decompile> <fixture> [name|0xADDR]");
  process.exit(64);
}

const binary = join(kunaDir, "fixtures", fixture);
const args = [join(here, "kuna-wasi-run.mjs"), join(kunaDir, "kuna_wasm.wasm"), join(kunaDir, "specs"), binary, command];
if (target !== undefined) args.push(target);

// The engine prints a warning banner on some Node versions; only stdout is read.
const output = execFileSync(process.execPath, args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  maxBuffer: 512 * 1024 * 1024,
});

const parsed = JSON.parse(output);

if (command === "list") {
  console.log(
    JSON.stringify({
      count: parsed.count,
      names: parsed.functions.map((entry) => entry.name),
    }),
  );
} else {
  const [first] = parsed.functions;
  console.log(JSON.stringify({ name: first.name, code: first.code, address: first.address_hex, size: first.size }));
}
