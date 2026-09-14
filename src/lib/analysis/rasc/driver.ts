/**
 * The Rasc engine, as far as the rest of Repi is concerned.
 *
 * This is the only module that knows Rasc exists on the page side. It owns the
 * Worker, the wasm URL and the command protocol, and it hands back plain data.
 * Everything above it talks to `AnalysisSource` and has no idea any of this is
 * here.
 *
 * Three things about the engine shape this module, and they are the same three
 * that shape the Kuna driver:
 *
 *  - **It is loaded per file.** A Rasc instance is bound to one archive's byte
 *    source, so the session takes the `File` and posts it once.
 *  - **Its execution cannot be interrupted.** A run is one synchronous call into
 *    WebAssembly; a cancel message could not be read until the work it was
 *    cancelling had finished. Cancelling is therefore `Worker.terminate()` and a
 *    fresh Worker, which is what the client does, and the file is kept on the
 *    page side so the next command rehydrates the session.
 *  - **It reports no progress.** One call, one answer. The adapter above passes
 *    that on honestly rather than inventing a fraction.
 */

import type { RascResponse } from "./protocol";
import { artifactAvailable, artifactUrl } from "../engine-artifacts";

/** Where `npm run build:rasc` puts the module. Same origin, always. */
const WASM_PATH = artifactUrl("rasc", "rasc.wasm");


export class RascUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RascUnavailableError";
  }
}

/** Raised when a run was in flight and the Worker was terminated under it. */
export class RascCancelledError extends Error {
  constructor(message = "The engine was cancelled.") {
    super(message);
    this.name = "RascCancelledError";
  }
}

export interface RascRun {
  /** The exit code the CLI would have reported. Zero means the payload is the answer. */
  readonly code: number;
  /** The payload, when the caller did not stream it. Empty when `onChunk` was given. */
  readonly output: Uint8Array;
  /** Linear memory in use after the run. Reports a real figure or nothing. */
  readonly memoryBytes: number;
}

export interface RascRunOptions {
  /** Receives the payload as it is produced, so a large one is never held whole. */
  readonly onChunk?: (bytes: Uint8Array) => void;
  /**
   * How far the command's walk over the archive's entries has got.
   *
   * It is a real fraction over a total the engine knew before it started, never an
   * estimate, and it arrives while the work is still running: the Worker posts it and
   * the page is a different thread.
   */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface RascSession {
  /**
   * Runs one command. `args` are the CLI arguments after the program name; the
   * archive argument is a label, because the bytes always come from the file this
   * session was opened with.
   */
  run(args: readonly string[], options?: RascRunOptions): Promise<RascRun>;
  /** The last reported linear memory size, or null before the first run. */
  memoryBytes(): number | null;
  /** Terminates the Worker. The next `run` builds a clean one and rehydrates. */
  cancel(): void;
  /** Releases the Worker for good. */
  close(): void;
}

/**
 * Whether the artifacts are on the server at all.
 *
 * Checked before a Worker is spawned, so a missing engine produces one clear
 * sentence instead of a Worker that fails to initialise for reasons the page
 * cannot explain. The probe and its caching live in `engine-artifacts`, shared
 * with the other engine, because both had written this the same wrong way.
 */
export function rascAvailable(): Promise<boolean> {
  return artifactAvailable(WASM_PATH, 500_000);
}

export interface RascSessionOptions {
  /** Overridable so a check can point at another module. */
  readonly wasmUrl?: string;
  /** Check seam: hold each command's answer this long, so a cancel can land. */
  readonly delayMs?: number;
}

interface Pending {
  readonly resolve: (run: RascRun) => void;
  readonly reject: (error: Error) => void;
  readonly onChunk: ((bytes: Uint8Array) => void) | undefined;
  readonly onProgress: ((done: number, total: number) => void) | undefined;
  readonly chunks: Uint8Array[];
}

export function openRascSession(file: File, options: RascSessionOptions = {}): RascSession {
  const wasmUrl = options.wasmUrl ?? WASM_PATH;
  const pending = new Map<number, Pending>();
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  /** Rejects the load that is in flight, so a cancel cannot leave it hanging. */
  let abandonLoad: ((error: Error) => void) | null = null;
  let nextId = 1;
  let closed = false;
  let memory: number | null = null;

  function terminate(error: Error): void {
    const open = Array.from(pending.values(), (entry) => entry.reject);
    pending.clear();
    worker?.terminate();
    worker = null;
    ready = null;
    abandonLoad?.(error);
    abandonLoad = null;
    for (const reject of open) reject(error);
  }

  function receive(event: MessageEvent<RascResponse>): void {
    const message = event.data;

    if (message.type === "ready") return;

    if (message.type === "chunk") {
      const entry = pending.get(message.id);
      if (!entry) return;
      if (entry.onChunk) entry.onChunk(message.bytes);
      else entry.chunks.push(message.bytes);
      return;
    }

    if (message.type === "progress") {
      pending.get(message.id)?.onProgress?.(message.done, message.total);
      return;
    }

    if (message.type === "failed") {
      if (message.id === null) {
        // A load failure: no run is waiting, so the next run must retry the load.
        ready = null;
        terminate(new RascUnavailableError(message.message));
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      entry.reject(new Error(message.message));
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    memory = message.memoryBytes;

    let output = new Uint8Array(0);
    if (!entry.onChunk && entry.chunks.length > 0) {
      const length = entry.chunks.reduce((total, chunk) => total + chunk.length, 0);
      output = new Uint8Array(length);
      let at = 0;
      for (const chunk of entry.chunks) {
        output.set(chunk, at);
        at += chunk.length;
      }
    }
    entry.resolve({ code: message.code, output, memoryBytes: message.memoryBytes });
  }

  function ensureWorker(): Worker {
    if (worker !== null) return worker;
    const created = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "rasc",
    });
    // Once, on creation: a listener added per call would deliver every message
    // as many times as the session has run commands.
    created.addEventListener("message", receive);
    worker = created;
    return created;
  }

  function load(): Promise<void> {
    if (ready !== null) return ready;

    const attempt = new Promise<void>((resolve, reject) => {
      const target = ensureWorker();
      /*
       * Cancelling while this is in flight has to reject it. The Worker is gone,
       * so nothing will ever answer — and the caller is waiting on this promise,
       * not on the run it has not posted yet, so a terminate that only rejected
       * the run would leave a scan stuck on "reading" for as long as the page is
       * open. That is exactly what the first version of this did.
       */
      abandonLoad = reject;
      const onReady = (event: MessageEvent<RascResponse>) => {
        if (event.data.type !== "ready") return;
        target.removeEventListener("message", onReady);
        target.removeEventListener("message", onFailed);
        abandonLoad = null;
        resolve();
      };
      const onFailed = (event: MessageEvent<RascResponse>) => {
        if (event.data.type !== "failed" || event.data.id !== null) return;
        target.removeEventListener("message", onReady);
        target.removeEventListener("message", onFailed);
        abandonLoad = null;
        reject(new RascUnavailableError(event.data.message));
      };
      target.addEventListener("message", onReady);
      target.addEventListener("message", onFailed);
      target.postMessage({ type: "load", file, wasmUrl, delayMs: options.delayMs ?? 0 });
    });

    ready = attempt;
    // A failed load must not be remembered as the answer: the next command
    // rehydrates, which is the same path a cancel takes.
    attempt.catch(() => {
      if (ready === attempt) ready = null;
    });
    return attempt;
  }

  return {
    async run(args, options = {}) {
      if (closed) throw new RascUnavailableError("The engine session is closed.");
      await load();
      const id = (nextId += 1);
      const result = new Promise<RascRun>((resolve, reject) => {
        pending.set(id, {
          resolve,
          reject,
          onChunk: options.onChunk,
          onProgress: options.onProgress,
          chunks: [],
        });
      });
      ensureWorker().postMessage({ type: "run", id, args });
      return result;
    },

    memoryBytes: () => memory,

    cancel() {
      terminate(new RascCancelledError());
      memory = null;
    },

    close() {
      closed = true;
      terminate(new RascCancelledError("The engine session is closed."));
    },
  };
}
