/// <reference lib="webworker" />

/**
 * The sandbox, in a Worker, with the engines beside it.
 *
 * Interpreter and engines share this thread on purpose. A wasm interpreter cannot await, so an
 * engine call from inside a program has to be an ordinary function call all the way down —
 * which is only possible if the engine is instantiated synchronously right here. A message
 * per engine call would make `rasc(...)` a promise-shaped protocol the sandbox has no way to
 * drive.
 *
 * **Capabilities are provided on demand, not decided up front.** The page declares what the
 * host *can* provide (which engines are installed); the program calls whatever it needs. The
 * first call to something that is not warm fails with a marker, the worker fetches and
 * compiles it between programs, and the program is run again — so a model never has to know
 * that an engine had to be loaded, and never has to know which one the attached file implies.
 * The same loop already handles Kuna's SLEIGH specs, which is the other thing that arrives
 * asynchronously.
 *
 * That is what makes one program able to look at both layers of an APK: `rasc(...)` for the
 * DEX side, `extract(...)` for a native library inside it, `kuna(...)` for that library. The
 * attached file is never copied — the mount is `Blob`-backed — and the second engine's wasm is
 * only fetched if a program actually asks for it.
 *
 * The Worker is also the kill switch: a program that ignores its deadline, or a host that
 * wants to stop, ends with `Worker.terminate()`.
 */
import { extractEntry, type ReadAt } from "../analysis/archive/zip-extract";
import { createKunaHost, kunaMounts, type KunaHost } from "../analysis/kuna/kuna-host";
import { DEFAULT_MAX_INFLATED_ENTRY } from "../analysis/rasc/limits";
import { ARCHIVE_PATH, MOUNT, runCommandSync } from "../analysis/rasc/wasi";
import { Sandbox, type EngineOutcome, type SandboxLimits, type SandboxOutcome } from "./quickjs-sandbox";

export type SandboxEngine = "rasc" | "kuna";

/** An engine the host can provide: its name and where its module lives. */
export interface EngineSource {
  readonly name: SandboxEngine;
  readonly wasmUrl: string;
}

export interface SandboxLoadRequest {
  readonly type: "load";
  /** The binary under analysis, mounted read-only at `ARCHIVE_PATH`. */
  readonly file: File;
  /**
   * The shared virtual filesystem: what earlier sessions produced, by path.
   *
   * Mounted read-only, so a program can open a library another conversation extracted without
   * being able to damage it — and so the sandbox is the same filesystem from every
   * conversation rather than a private scratch copy of one.
   */
  readonly vfs?: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  /** Every engine this deployment has. A program may call any of them. */
  readonly engines: readonly EngineSource[];
  /**
   * Which engine to have ready before the first program runs.
   *
   * A hint and nothing more: it saves the first program a round trip for the engine the
   * attached file's format suggests, and a program that wants the other one still gets it.
   */
  readonly warm?: SandboxEngine;
  /** The mounted archive was this large… */
  readonly maxInflatedEntry?: number;
  /** Kuna's spec tree, when Kuna is one of the engines. */
  readonly specRoot?: string;
  readonly smallBundleUrl?: string;
  readonly limits?: SandboxLimits;
}

export interface SandboxRunRequest {
  readonly type: "run";
  readonly id: number;
  readonly code: string;
}

export type SandboxRequest = SandboxLoadRequest | SandboxRunRequest;

export type SandboxState = "ready" | "loadable" | "unavailable";

export type SandboxResponse =
  | { readonly type: "ready"; readonly size: number; readonly engine: SandboxEngine | null }
  | {
      readonly type: "done";
      readonly id: number;
      readonly outcome: SandboxOutcome;
      /** Files the program produced, for the host to keep: the shared VFS grows by these. */
      readonly produced: readonly { readonly path: string; readonly bytes: Uint8Array }[];
    }
  | { readonly type: "failed"; readonly id: number | null; readonly message: string };

interface Loaded {
  readonly file: File;
  readonly sources: Map<SandboxEngine, string>;
  readonly maxInflatedEntry: number;
  readonly specRoot: string;
  readonly smallBundleUrl: string | null;
  /** Engines whose module is compiled and whose host is ready. */
  readonly ready: Map<SandboxEngine, { readonly module: WebAssembly.Module; readonly kuna: KunaHost | null }>;
  /** Engines a program asked for and the worker has not provisioned yet. */
  readonly wanted: Set<SandboxEngine>;
  /** The shared virtual filesystem, read-only: what earlier sessions produced. */
  readonly shared: Map<string, Uint8Array>;
  /** The writable side: `extract()` results and whatever an engine or program wrote. */
  readonly written: Map<string, Uint8Array>;
}

let loaded: Loaded | null = null;
let sandbox: Sandbox | null = null;

function post(message: SandboxResponse): void {
  (self as unknown as { postMessage(m: SandboxResponse): void }).postMessage(message);
}

const decoder = new TextDecoder();

/** A synchronous read of the mounted file, which is what the WASI filesystem needs. */
function blobReader(file: Blob): ReadAt {
  const reader = new FileReaderSync();
  return (offset, length) =>
    new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + length)));
}

/** Runs one engine call against the module that is already compiled. */
function runEngine(
  state: Loaded,
  name: SandboxEngine,
  args: readonly unknown[],
  engine: { module: WebAssembly.Module; kuna: KunaHost | null },
): EngineOutcome {
  const argv = args.map((arg) => String(arg));
  if (name === "kuna") {
    if (engine.kuna === null) throw new Error("kuna was compiled without its spec tree");
    const outcome = engine.kuna.run(argv, kunaMounts(state.file, state.written), state.shared);
    for (const [file, bytes] of engine.kuna.leaves()) state.written.set(file, bytes);
    return outcome;
  }
  const result = runCommandSync({
    wasm: engine.module,
    file: state.file,
    args: argv,
    env: { RASC_MAX_INFLATED_ENTRY: String(state.maxInflatedEntry) },
    mounts: state.written,
    readOnly: state.shared,
  });
  for (const [name, bytes] of result.written) state.written.set(name, bytes);
  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    code: result.code,
  };
}

/**
 * The capabilities a program may reach.
 *
 * Every engine this deployment has is a name the program can call immediately; one that is not
 * warm yet says so once, is provisioned between programs, and the program is run again. Names
 * the deployment does not have say that instead, which is a different sentence on purpose.
 */
function hostFor(state: Loaded) {
  const engine =
    (name: SandboxEngine) =>
    (args: readonly unknown[]): EngineOutcome => {
      const ready = state.ready.get(name);
      if (ready) return runEngine(state, name, args, ready);
      if (!state.sources.has(name)) {
        throw new Error(`${name} is not installed in this build`);
      }
      state.wanted.add(name);
      throw new Error(`${name} was not loaded yet: the host is loading it, and will run this program again`);
    };

  return {
    functions: {
      rasc: engine("rasc"),
      kuna: engine("kuna"),

      /**
       * What is in the sandbox: the shared files, the attachment, and each one's size.
       *
       * This is the same list the storage panel shows, which is the point — a program and a
       * person are looking at one filesystem, not at two views of it.
       */
      ls(): { path: string; bytes: number; readOnly: boolean }[] {
        // One entry per path: a file that exists both shared and rewritten in this session is
        // one file, and the writable copy is the one a program would open.
        const byPath = new Map<string, { path: string; bytes: number; readOnly: boolean }>([
          [ARCHIVE_PATH, { path: ARCHIVE_PATH, bytes: state.file.size, readOnly: true }],
        ]);
        for (const [name, bytes] of state.shared) {
          byPath.set(`${MOUNT}/${name}`, { path: `${MOUNT}/${name}`, bytes: bytes.byteLength, readOnly: true });
        }
        for (const [name, bytes] of state.written) {
          byPath.set(`${MOUNT}/${name}`, { path: `${MOUNT}/${name}`, bytes: bytes.byteLength, readOnly: false });
        }
        return [...byPath.values()];
      },

      /**
       * Pulls one entry out of the archive and mounts it for the next call.
       *
       * This is what lets one program cross layers: a native library inside an APK is not a
       * file the engines can reach, so the host takes it out of the ZIP and mounts it — where
       * Kuna can open it — reading only that entry.
       */
      extract(args: readonly unknown[]): { path: string; bytes: number } {
        const path = String(args[0] ?? "");
        if (path === "") throw new Error("extract(path) needs the name of an archive entry");
        const entry = extractEntry(blobReader(state.file), state.file.size, path);
        // The entry's own path, not its basename: two architectures hold the same library
        // name, and a tree that flattens them cannot show both.
        const mounted = entry.name.replace(/^\/+/, "");
        state.written.set(mounted, entry.bytes);
        return { path: `${MOUNT}/${mounted}`, bytes: entry.bytes.length };
      },

      /**
       * What this sandbox can do, and what is already loaded.
       *
       * Cheap enough that a program may ask before deciding, and the honest answer to "is
       * there a tool for this" — which is a question the model otherwise has to guess at.
       */
      tools(): Record<string, string> {
        const report: Record<string, string> = { extract: "ready" };
        for (const name of ["rasc", "kuna"] as const) {
          report[name] = state.ready.has(name)
            ? "ready"
            : state.sources.has(name)
              ? "available (the host will load it when you call it)"
              : "not installed in this build";
        }
        return report;
      },
    },
  };
}

/** Fetches, compiles and prepares one engine. Returns false when it could not be had. */
async function provision(state: Loaded, name: SandboxEngine): Promise<boolean> {
  const wasmUrl = state.sources.get(name);
  if (wasmUrl === undefined) return false;
  const response = await fetch(wasmUrl);
  if (!response.ok) return false;
  const module = await WebAssembly.compile(await response.arrayBuffer());
  const kuna =
    name === "kuna"
      ? await createKunaHost({
          wasm: module,
          specRoot: state.specRoot,
          ...(state.smallBundleUrl ? { smallBundleUrl: state.smallBundleUrl } : {}),
        })
      : null;
  state.ready.set(name, { module, kuna });
  return true;
}

self.onmessage = async (event: MessageEvent<SandboxRequest>) => {
  const request = event.data;
  try {
    if (request.type === "load") {
      const state: Loaded = {
        file: request.file,
        sources: new Map(request.engines.map((engine) => [engine.name, engine.wasmUrl])),
        maxInflatedEntry: request.maxInflatedEntry ?? DEFAULT_MAX_INFLATED_ENTRY,
        // A worker has no document, so every URL arrives from the page.
        specRoot: request.specRoot ?? "/kuna/specs",
        smallBundleUrl: request.smallBundleUrl ?? null,
        ready: new Map(),
        wanted: new Set(),
        shared: new Map((request.vfs ?? []).map((entry) => [entry.path.split("/").pop() ?? entry.path, entry.bytes])),
        written: new Map(),
      };
      loaded = state;
      sandbox = new Sandbox(hostFor(state), request.limits);
      if (request.warm) await provision(state, request.warm);
      post({ type: "ready", size: state.file.size, engine: request.warm ?? null });
      return;
    }

    if (!sandbox || !loaded) throw new Error("no binary is loaded");
    const state = loaded;

    /**
     * Run, prepare what the run turned out to need, run again.
     *
     * Two things arrive asynchronously and both are discovered by failing: an engine whose
     * module is not compiled, and Kuna's SLEIGH spec for an architecture. Neither is something
     * the caller should have to know about, so the loop here is bounded, and a run that needed
     * nothing new leaves after the first pass.
     */
    let outcome = await sandbox.run(request.code);
    for (let round = 0; round < 3; round += 1) {
      const missingSpecs = state.ready.get("kuna")?.kuna?.missingLanguages().length ?? 0;
      if (state.wanted.size === 0 && missingSpecs === 0) break;

      let prepared = 0;
      for (const name of [...state.wanted]) {
        state.wanted.delete(name);
        if (await provision(state, name)) prepared += 1;
      }
      const kuna = state.ready.get("kuna")?.kuna;
      if (kuna) prepared += await kuna.fetchMissing().catch(() => 0);
      if (prepared === 0) break;

      outcome = await sandbox.run(request.code);
    }

    post({
      type: "done",
      id: request.id,
      outcome,
      produced: [...state.written].map(([name, bytes]) => ({ path: `${MOUNT}/${name}`, bytes })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "failed", id: request.type === "run" ? request.id : null, message });
  }
};

/** Kept so the mount path is visible from both sides without importing the engine module. */
export { ARCHIVE_PATH };
