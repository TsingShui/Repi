/**
 * The sandbox, as the page sees it.
 *
 * One session is one Worker, one binary and one interpreter; `run` sends a program and waits
 * for its answer. Nothing here knows what a program does — it carries code in and an outcome
 * out, and the outcome is what the model reads.
 *
 * Cancellation is `Worker.terminate()`, and for the same reason it is in the engine driver: a
 * program inside a wasm interpreter is one call that returns when it is finished, so a
 * message asking it to stop could not be read until it had already stopped. The interpreter's
 * own deadline handles the ordinary case (`while (true) {}` ends as an error the agent can
 * read); termination is for the host's patience running out.
 */
import { artifactUrl } from "../analysis/engine-artifacts";
import { DEFAULT_MAX_INFLATED_ENTRY } from "../analysis/rasc/limits";
import type { SandboxLimits, SandboxOutcome } from "./quickjs-sandbox";
import type { SandboxEngine, SandboxRequest, SandboxResponse } from "./sandbox-worker";

/**
 * Where the build puts each engine. Resolved on the page, because a Worker has no `document`
 * to resolve a relative artifact path against.
 */
export const ENGINE_WASM: Record<SandboxEngine, string> = {
  rasc: artifactUrl("rasc", "rasc.wasm"),
  kuna: artifactUrl("kuna", "kuna_wasm.wasm"),
};

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxCancelledError extends Error {
  constructor(message = "The sandbox was cancelled.") {
    super(message);
    this.name = "SandboxCancelledError";
  }
}

export interface SandboxSession {
  /** Runs one program and resolves with what it printed, returned, or failed with. */
  run(code: string): Promise<SandboxOutcome>;
  /**
   * Adds or replaces files in the shared filesystem this session has mounted.
   *
   * The mount is a snapshot from load time, which is right for a program and wrong for a
   * conversation: the agent writes a file with its own hands and then opens it in a program a
   * moment later. Only the files that changed are sent — what the caller has, not the whole
   * filesystem again — and reloading the session instead would refetch the engines with it.
   */
  refreshVfs(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Promise<void>;
  /** Kills the Worker. The session is unusable afterwards. */
  cancel(): void;
  close(): void;
}

export interface SandboxSessionOptions {
  /**
   * Every engine this deployment has, by name. A program may call any of them; the sandbox
   * loads one when it is first asked for.
   */
  readonly engines: readonly SandboxEngine[];
  /**
   * Which engine to have ready before the first program runs — a hint that saves a round trip,
   * not a limit. Left out, the first program pays for whatever it uses.
   */
  readonly warm?: SandboxEngine;
  /**
   * The shared virtual filesystem: files earlier sessions produced, mounted read-only so any
   * conversation can open them and none can damage them.
   */
  readonly vfs?: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  /**
   * Files the program produced, handed over as they are: `extract()` results and anything an
   * engine wrote. Persisting them is the caller's business, because only it knows the store.
   */
  readonly onProduced?: (files: readonly { readonly path: string; readonly bytes: Uint8Array }[]) => void;
  readonly maxInflatedEntry?: number;
  /** Kuna's spec tree. Required when `engines` includes Kuna. */
  readonly specRoot?: string;
  readonly smallBundleUrl?: string;
  readonly limits?: SandboxLimits;
}

export function openSandbox(file: File, options: SandboxSessionOptions): SandboxSession {
  const pending = new Map<
    number,
    {
      resolve: (o: SandboxOutcome) => void;
      reject: (e: Error) => void;
      onProduced: SandboxSessionOptions["onProduced"];
    }
  >();
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  let nextId = 1;
  let closed = false;

  function terminate(error: Error): void {
    const waiting = [...pending.values()];
    pending.clear();
    worker?.terminate();
    worker = null;
    ready = null;
    for (const entry of waiting) entry.reject(error);
  }

  function receive(event: MessageEvent<SandboxResponse>): void {
    const message = event.data;
    if (message.type === "ready") return;
    if (message.type === "failed") {
      if (message.id === null) {
        ready = null;
        terminate(new SandboxUnavailableError(message.message));
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
    // Hand the produced files over before resolving: the caller decides what to keep, and a
    // program's output is worth keeping whether or not its last statement succeeded.
    if (entry.onProduced && message.produced.length > 0) entry.onProduced(message.produced);
    entry.resolve(message.outcome);
    // The program cut the interpreter short, so it is abandoned rather than reused: the next
    // call starts a clean Worker instead of inheriting an exhausted heap.
    if (message.outcome.poisoned) terminate(new SandboxCancelledError("The sandbox was recycled."));
  }

  function post(request: SandboxRequest): void {
    if (worker === null) {
      worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
        type: "module",
        name: "rasc-sandbox",
      });
      worker.addEventListener("message", receive);
    }
    worker.postMessage(request);
  }

  function load(): Promise<void> {
    if (ready !== null) return ready;
    const attempt = new Promise<void>((resolve, reject) => {
      const onReady = (event: MessageEvent<SandboxResponse>) => {
        if (event.data.type !== "ready") return;
        worker?.removeEventListener("message", onReady);
        resolve();
      };
      const onFailed = (event: MessageEvent<SandboxResponse>) => {
        if (event.data.type !== "failed" || event.data.id !== null) return;
        worker?.removeEventListener("message", onFailed);
        reject(new SandboxUnavailableError(event.data.message));
      };
      post({
        type: "load",
        file,
        ...(options.vfs ? { vfs: options.vfs } : {}),
        engines: options.engines.map((name) => ({ name, wasmUrl: ENGINE_WASM[name] })),
        ...(options.warm ? { warm: options.warm } : {}),
        maxInflatedEntry: options.maxInflatedEntry ?? DEFAULT_MAX_INFLATED_ENTRY,
        ...(options.specRoot ? { specRoot: options.specRoot } : {}),
        ...(options.smallBundleUrl ? { smallBundleUrl: options.smallBundleUrl } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
      });
      // The listener that resolves this has to exist before the message is answered, and the
      // Worker was created by `post` above, so the events arrive here first.
      worker?.addEventListener("message", onReady);
      worker?.addEventListener("message", onFailed);
    });
    ready = attempt;
    attempt.catch(() => {
      if (ready === attempt) ready = null;
    });
    return attempt;
  }

  return {
    async run(code) {
      if (closed) throw new SandboxUnavailableError("The sandbox is closed.");
      await load();
      const id = (nextId += 1);
      const outcome = new Promise<SandboxOutcome>((resolve, reject) => {
        pending.set(id, { resolve, reject, onProduced: options.onProduced });
      });
      post({ type: "run", id, code });
      return outcome;
    },
    async refreshVfs(files) {
      // Before the first run there is nothing loaded to refresh, and the load will carry its own
      // snapshot anyway.
      if (closed || ready === null || files.length === 0) return;
      await load().catch(() => undefined);
      post({ type: "vfs", vfs: files });
    },
    cancel() {
      terminate(new SandboxCancelledError());
    },
    close() {
      closed = true;
      terminate(new SandboxCancelledError("The sandbox is closed."));
    },
  };
}
