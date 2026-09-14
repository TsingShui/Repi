/**
 * The Kuna engine, as far as the rest of Repi is concerned.
 *
 * This is the only module that knows Kuna exists. It owns the Worker, the WASI
 * shim and the wasm, and it hands back plain data. Everything above it talks to
 * `AnalysisSource` and has no idea any of this is here.
 *
 * Three things about the engine shape this module:
 *
 *  - **It is large.** 9.2 MB of wasm plus a 2.3 MB spec bundle, fetched on first
 *    use and never again: the Worker holds the engine for the life of the page.
 *  - **Its execution cannot be interrupted.** WASI runs synchronously once
 *    `wasi.start()` enters WebAssembly, so a cancel message could not be read
 *    until the work it is cancelling has finished. Cancelling is therefore
 *    `Worker.terminate()` and a fresh Worker, which is what the client does.
 *  - **It reports no progress.** A run is one call; there is nothing to report a
 *    fraction of. The adapter above this passes that on honestly rather than
 *    inventing one.
 */

import {
  KunaWorkerClient,
  KunaWorkerCancelledError,
} from "../../../vendor/kuna/kuna-worker-client.js";
import { artifactAvailable, artifactUrl } from "../engine-artifacts";

const WASM_PATH = artifactUrl("kuna", "kuna_wasm.wasm");

export type KunaFunctionKind = "func" | "plt" | "thunk";

/** One row of the engine's inventory. */
export interface KunaFunction {
  readonly name: string;
  readonly address: number;
  readonly address_hex: string;
  readonly aliases: readonly string[];
  readonly size: number;
  readonly kind: KunaFunctionKind;
}

export interface KunaVariable {
  readonly name: string;
  readonly type: string;
  readonly kind: string;
  readonly arg_index: number | null;
  readonly stack_offset: number | null;
  readonly size: number;
}

/** One function's decompilation. `code` is null when the engine failed on it. */
export interface KunaResult {
  readonly name: string;
  readonly address: number;
  readonly address_hex: string;
  readonly aliases: readonly string[];
  readonly size: number;
  readonly kind: KunaFunctionKind;
  readonly code: string | null;
  readonly error: string | null;
  readonly variables: readonly KunaVariable[];
}

export interface KunaInventory {
  readonly format: string;
  readonly count: number;
  readonly functions: readonly KunaFunction[];
}

/**
 * Raised when the engine was cancelled. Re-exported so callers can tell a
 * cancel apart from a failure without importing the harness themselves.
 */
export { KunaWorkerCancelledError };

export class KunaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KunaUnavailableError";
  }
}

/**
 * Whether the artifacts are on the server at all.
 *
 * Checked before a Worker is spawned, so a missing engine produces one clear
 * sentence instead of a Worker that fails to initialise for reasons the page
 * cannot explain. The probe and its caching live in `engine-artifacts`, shared
 * with the other engine, because both had written this the same wrong way.
 */
export function kunaAvailable(): Promise<boolean> {
  return artifactAvailable(WASM_PATH, 1_000_000);
}

let client: KunaWorkerClient | null = null;

/**
 * The engine, started on first use.
 *
 * `workerFactory` is not a convenience. Vite finds Workers by looking for a
 * literal `new Worker(new URL(..., import.meta.url))`, and the client builds its
 * Worker from a parameter, which no bundler can see. Spelling the URL out here
 * is what makes the Worker a real, bundled, emitted file.
 */
function engine(): KunaWorkerClient {
  client ??= new KunaWorkerClient({
    workerFactory: () =>
      new Worker(new URL("../../../vendor/kuna/kuna-worker.js", import.meta.url), {
        type: "module",
        name: "kuna",
      }),
    wasmUrl: WASM_PATH,
    specRoot: artifactUrl("kuna", "specs"),
    smallBundleUrl: artifactUrl("kuna", "specs-small.json"),
  });
  return client;
}

export interface KunaSession {
  /** Inventories the binary. The engine's own `list`. */
  load(bytes: Uint8Array, mode?: string): Promise<KunaInventory>;
  /** Decompiles one function by name or `0x`-address. */
  decompile(target: string): Promise<KunaResult>;
  /** Terminates the Worker and starts a clean one. Rehydrates on next use. */
  cancel(): void;
  /** Releases the engine entirely. */
  close(): void;
  /** The Worker generation, which changes on every cancel. Exposed for tests. */
  generation(): number;
}

export function openKunaSession(): KunaSession {
  const instance = engine();
  let loaded = false;

  return {
    async load(binary, mode = "auto") {
      const inventory = await instance.load(binary, { fileName: "binary", mode });
      loaded = true;
      return inventory as KunaInventory;
    },

    async decompile(target) {
      if (!loaded) throw new KunaUnavailableError("No binary is loaded.");
      const result = await instance.decompile(target);
      // The engine returns one record per entry. A single-function request is
      // always exactly one, and anything else means the two sides disagree.
      const [first] = (result as { functions?: readonly KunaResult[] }).functions ?? [];
      if (!first) throw new KunaUnavailableError(`The engine returned nothing for ${target}.`);
      return first;
    },

    cancel() {
      instance.cancel();
      loaded = false;
    },

    close() {
      instance.close();
      client = null;
      loaded = false;
    },

    generation: () => instance.generation,
  };
}
