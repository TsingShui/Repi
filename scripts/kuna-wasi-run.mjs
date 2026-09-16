/**
 * Runs the native Kuna CLI wasm under Node's built-in WASI. It is the small half of
 * `scripts/kuna-oracle.mjs`, kept separate because a Node process cannot both host
 * WASI and capture its own stdout.
 *
 * All arguments after the binary are passed to Kuna unchanged. This is intentionally the
 * browser contract too: a caller gives native CLI argv, while the host pins `--sleighpath`
 * to the preopened spec tree.
 */
import { WASI } from "node:wasi";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

const [wasmPath, specsDir, binaryPath, command, ...commandArgs] = process.argv.slice(2);

if (!wasmPath || !specsDir || !binaryPath || !command) {
  console.error("usage: kuna-wasi-run.mjs <wasm> <specs-dir> <binary> <command> [command args…]");
  process.exit(64);
}

// The virtual filesystem the guest sees: compiled specs and the binary, both preopened,
// exactly as the browser shim presents them.
const wasi = new WASI({
  version: "preview1",
  args: ["kuna", command, `/work/${basename(binaryPath)}`, ...commandArgs, "--sleighpath", "/specs"],
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
