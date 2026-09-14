/**
 * The engine's own answer, for the check suite to compare against.
 *
 * The browser and Node drive the same wasm, but through different hosts: the page
 * serves ranges from a `Blob` in a Worker, and this serves them from a file
 * descriptor with `readSync`. If the two disagree, the browser path mangled
 * something, and no amount of reading the DOM would reveal it — the DOM would
 * simply be showing the wrong thing confidently. It is also what makes a DEX
 * comparable: the page wraps a bare DEX in a one-entry archive, and the check
 * compares that against the same DEX inside a real one.
 *
 * Prints JSON on stdout. Reads the artifacts `npm run build:rasc` produces, so it
 * needs no Rasc checkout of its own.
 *
 *   node scripts/rasc-oracle.mjs classes fixture.apk
 *   node scripts/rasc-oracle.mjs getclass fixture.apk Lcom/example/Fixture0;
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Rasc, withReadAhead } from "../src/vendor/rasc/rasc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const wasmPath = join(projectRoot, "public/rasc/rasc.wasm");

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: rasc-oracle.mjs <command> <file> [args…]");
  process.exit(64);
}

const file = resolve(args[1]);
const fd = openSync(file, "r");
const size = statSync(file).size;
const source = withReadAhead({
  size,
  read(offset, length, into) {
    return readSync(fd, into, 0, length, offset);
  },
  close() {
    closeSync(fd);
  },
});

let rasc;
try {
  rasc = await Rasc.load({ wasm: readFileSync(wasmPath), source });
} catch (error) {
  console.error(`The Rasc module is not built: ${error}\nRun \`npm run build:rasc\`.`);
  process.exit(2);
}

// The archive argument is a label — the host serves the bytes — so the real file
// name is what the engine's own messages should name.
const { code, output } = rasc.run([args[0], file, ...args.slice(2)]);
rasc.close();

const text = Buffer.from(output).toString("utf8");
if (code !== 0) {
  console.error(text.trimEnd() || `the engine exited with code ${code}`);
  process.exit(code);
}

console.log(JSON.stringify({ code, text }));
