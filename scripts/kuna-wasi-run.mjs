/**
 * Runs the Kuna wasm under Node's built-in WASI and writes the engine's JSON to
 * stdout. The small half of `scripts/kuna-oracle.mjs`, kept separate because a
 * Node process cannot both be the WASI host and capture the host's own stdout.
 */
import { WASI } from "node:wasi";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

const [wasmPath, specsDir, binaryPath, command, target] = process.argv.slice(2);

if (!wasmPath || !specsDir || !binaryPath || !command) {
  console.error("usage: kuna-wasi-run.mjs <wasm> <specs-dir> <binary> <list|decompile> [target]");
  process.exit(64);
}

// The virtual filesystem the guest sees: the SLEIGH tree and the binary, both
// preopened, which is exactly how the browser shim presents them.
const wasi = new WASI({
  version: "preview1",
  args: ["kuna_wasm", `/work/${basename(binaryPath)}`, "/specs", command, ...(target === undefined ? [] : [target])],
  env: {},
  preopens: { "/specs": specsDir, "/work": dirname(binaryPath) },
});

const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), wasi.getImportObject());

try {
  wasi.start(instance);
} catch (error) {
  // A non-zero guest exit is the engine reporting a failure; its JSON has
  // already gone to stdout, so only a real host error is worth surfacing.
  if (!/exited with code|WASI exit/i.test(String(error))) throw error;
}
