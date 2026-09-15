/**
 * The code sandbox: the agent's one tool.
 *
 * Instead of a tool per capability, the agent writes a short program. The program runs in
 * QuickJS — a real interpreter compiled to wasm — with exactly two things in scope: `print`
 * and the engines (`rasc(...)`, and later `kuna(...)`). No DOM, no `fetch`, no IndexedDB, no
 * `import`: the sandbox cannot reach anything the host did not hand it, which is the
 * difference between this and `eval` in a worker.
 *
 * What it buys, measured on a 126 MB APK: `classes` prints 19.4 MB / 76,983 rows, and a
 * five-line program that filters and groups them answers in about 70 ms and returns a few
 * hundred bytes. The bytes never enter the model's context, which is the whole point — the
 * alternative is a truncated table and a guess.
 *
 * Two things are deliberately *not* capped by politeness: the interpreter has a memory
 * ceiling and a deadline, both enforced by QuickJS itself, and both are recoverable — an
 * interrupt or an out-of-memory ends the run with an error the agent can read and fix, while
 * the host and the engine stay alive.
 */
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";

/** What one engine call returns: the two streams and the exit code, as a terminal would see them. */
export interface EngineOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * One host function: called with the arguments the program passed, and whatever it returns is
 * marshalled back in. Async is impossible here — the interpreter cannot await — so a function
 * that needs I/O has to be structured as a call plus a retry (see the Kuna host for the one
 * case where that matters).
 *
 * A call whose only argument is an array arrives as that array: `rasc(['manifest', path])` is
 * `['manifest', path]` here, not `[['manifest', path]]`, because every engine takes its command
 * line that way and one level of unwrapping is less surprising than one level of nesting.
 */
export type SandboxHostFunction = (args: readonly unknown[]) => unknown;

/**
 * The capabilities a program may reach.
 *
 * Named functions rather than a fixed interface: the same sandbox serves whichever engine the
 * attached file needs, and a program that calls the other one should hear why rather than see
 * an undefined-variable error.
 */
export interface SandboxHost {
  readonly functions: Readonly<Record<string, SandboxHostFunction>>;
}

export interface SandboxLimits {
  /** QuickJS heap ceiling. The engine's own output is copied in, so this has to fit it. */
  readonly memoryBytes?: number;
  readonly stackBytes?: number;
  /** Wall-clock budget for one program; a runaway loop is interrupted, not hung. */
  readonly deadlineMs?: number;
  /** Ceiling on `print` output alone: the result value has its own cap. */
  readonly maxPrintedBytes?: number;
  /** Ceiling on the returned value, which is what actually reaches the model. */
  readonly maxResultBytes?: number;
}

export interface SandboxError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

export interface SandboxOutcome {
  /** Everything `print()`ed, capped and marked when it was. */
  readonly printed: string;
  /** The last expression's value (or the `return`ed one), as JSON, capped like `printed`. */
  readonly result: string | null;
  readonly error: SandboxError | null;
  /**
   * True when the run left the interpreter unusable and the host should replace it.
   *
   * An out-of-memory run cannot be cleaned up: QuickJS asserts while freeing a runtime whose
   * heap ran out (`list_empty(&rt->gc_obj_list)`) and aborts the module, so the runtime is
   * abandoned instead — which holds its memory. The only reliable recovery is a new instance,
   * which is why the client recycles its Worker when this is set.
   */
  readonly poisoned: boolean;
  readonly ms: number;
  /** How many engine calls the program made. The expensive part, worth reporting. */
  readonly calls: number;
  readonly truncated: boolean;
}

const DEFAULTS = {
  memoryBytes: 256 << 20,
  stackBytes: 4 << 20,
  deadlineMs: 20_000,
  maxPrintedBytes: 64 << 10,
  maxResultBytes: 64 << 10,
};

/** Cuts a string at a byte ceiling, on a character boundary, and says so. */
function cap(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return { text, truncated: false };
  const kept = new TextDecoder().decode(bytes.subarray(0, limit));
  return {
    text: `${kept}\n[sandbox] output truncated: ${bytes.length} bytes total, ${limit} shown`,
    truncated: true,
  };
}

export class Sandbox {
  #host: SandboxHost;
  #limits: Required<SandboxLimits>;
  #module: QuickJSWASMModule | null = null;
  #runtime: QuickJSRuntime | null = null;
  /**
   * True once a run failed in a way that leaves the runtime unusable.
   *
   * Such a runtime must never be disposed: QuickJS asserts over its free list and aborts the
   * whole module (`list_empty(&rt->gc_obj_list)`), which in a worker means every later
   * program dies with it. Dropping the reference leaks one runtime inside the wasm instance
   * instead — and one instance is one tool call, which the worker terminates anyway.
   */
  #poisoned = false;

  constructor(host: SandboxHost, limits: SandboxLimits = {}) {
    this.#host = host;
    this.#limits = { ...DEFAULTS, ...limits };
  }

  /**
   * A runtime, or a fresh one if the last run poisoned it.
   *
   * An out-of-memory or an interrupt can leave a runtime unusable, and reusing it would make
   * every later program fail with a memory error it did not cause. The limits are per-runtime,
   * so they are installed here rather than per run.
   */
  async #runtimeFor(): Promise<QuickJSRuntime> {
    if (this.#runtime) return this.#runtime;
    this.#poisoned = false;
    // One variant, named: the meta package carries four (debug and asyncify beside this one),
    // and the bundler would ship every one of their wasm binaries — 4 MB against 1 MB.
    this.#module ??= await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    const runtime = this.#module.newRuntime();
    runtime.setMemoryLimit(this.#limits.memoryBytes);
    runtime.setMaxStackSize(this.#limits.stackBytes);
    this.#runtime = runtime;
    return runtime;
  }

  /** Drops the runtime: disposed when it is still healthy, abandoned when it is not. */
  #poison(): void {
    if (!this.#poisoned) this.#runtime?.dispose();
    this.#runtime = null;
    this.#poisoned = false;
  }

  /** Installs `print` and the engines on one context. */
  #install(context: QuickJSContext, printed: string[], counts: { calls: number }): void {
    const write = (...handles: QuickJSHandle[]) => {
      printed.push(handles.map((handle) => String(context.dump(handle))).join(" "));
    };
    const print = context.newFunction("print", write);
    context.setProp(context.global, "print", print);
    print.dispose();
    // `console.log` is what a model reaches for first; the same function costs nothing.
    // The assignment's own result is a handle like any other, and it holds the object it made:
    // an undisposed one keeps that object on the runtime's list for the runtime's whole life,
    // which is what `JS_FreeRuntime` then aborts on.
    const consoleSetup = context.evalCode(
      "globalThis.console = { log: print, error: print, warn: print, info: print };",
    );
    if (consoleSetup.error) consoleSetup.error.dispose();
    else consoleSetup.value.dispose();

    for (const [name, implementation] of Object.entries(this.#host.functions)) {
      const handle = context.newFunction(name, (...argHandles) => {
        const passed = argHandles.map((argHandle) => context.dump(argHandle));
        const args = passed.length === 1 && Array.isArray(passed[0]) ? (passed[0] as unknown[]) : passed;
        counts.calls += 1;
        try {
          return this.#marshal(context, implementation(args));
        } catch (thrown) {
          // A host failure is an exception the program can catch, not a silent `undefined`:
          // "that entry has no such name" belongs where the model can see it.
          const message = thrown instanceof Error ? thrown.message : String(thrown);
          throw context.newError(message);
        }
      });
      context.setProp(context.global, name, handle);
      handle.dispose();
    }
  }

  /**
   * Turns a host function's return value into a guest value.
   *
   * Arrays are arrays on the guest side too: a host that returns a list (`ls()` does) must not
   * arrive as an object with numeric keys, or `.map` and `.length` are the wrong kind of wrong.
   *
   * Every handle made here is disposed once its value is in the tree. `setProp` copies the
   * reference rather than taking the handle, so a handle left alive keeps its object alive for
   * good — and a runtime freed with objects still on its list aborts the wasm module outright
   * (`list_empty(&rt->gc_obj_list)`), which is a crash in the middle of a disposal rather than
   * anywhere useful. The leak was invisible for as long as nothing ever disposed a healthy
   * sandbox: a host function returning an object leaked one per call, and the check only found
   * it when a session was closed on purpose.
   */
  #marshal(context: QuickJSContext, value: unknown): QuickJSHandle {
    if (value === null) return context.null;
    if (value === undefined) return context.undefined;
    if (value === true) return context.true;
    if (value === false) return context.false;

    if (Array.isArray(value)) {
      const array = context.newArray();
      value.forEach((entry, index) => {
        const handle = this.#marshal(context, entry);
        context.setProp(array, index, handle);
        handle.dispose();
      });
      return array;
    }
    if (typeof value === "object") {
      const object = context.newObject();
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const handle = this.#marshal(context, entry);
        context.setProp(object, key, handle);
        handle.dispose();
      }
      return object;
    }
    if (typeof value === "number") return context.newNumber(value);
    if (typeof value === "bigint") return context.newBigInt(value);
    return context.newString(String(value));
  }

  /**
   * Runs one program.
   *
   * The program is evaluated as written, so its last expression is the result; if that is a
   * syntax error and the source contains a `return`, it is retried inside a function so a
   * top-level `return` works too. Retrying is safe because a syntax error cannot have run
   * anything.
   */
  /**
   * Runs one program.
   *
   * `deadlineMs` overrides the interpreter's budget for this run only. A program that decompiles
   * one function and one that walks a whole binary are the same code shape and wildly different
   * amounts of work, so the ceiling belongs to the caller that knows which it asked for.
   */
  async run(code: string, options: { readonly deadlineMs?: number } = {}): Promise<SandboxOutcome> {
    const started = performance.now();
    const printed: string[] = [];
    const counts = { calls: 0 };
    const runtime = await this.#runtimeFor();
    const context = runtime.newContext();
    let error: SandboxError | null = null;
    let result: string | null = null;

    try {
      runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + (options.deadlineMs ?? this.#limits.deadlineMs)),
      );
      this.#install(context, printed, counts);

      let evaluation = context.evalCode(code, "program.js");
      if (evaluation.error && /\breturn\b/.test(code) && this.#isSyntaxError(context, evaluation.error)) {
        evaluation.error.dispose();
        evaluation = context.evalCode(
          `(function(){\n${code}\n})()`,
          "program.js",
        );
      }

      if (evaluation.error) {
        error = this.#describe(context, evaluation.error);
        evaluation.error.dispose();
      } else {
        const dumped = context.dump(evaluation.value);
        evaluation.value.dispose();
        result = this.#stringify(dumped);
      }
    } catch (thrown) {
      // A poisoned runtime throws out of `evalCode` rather than returning an error; the next
      // program gets a clean one.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      error = { name: "SandboxError", message, stack: null };
      this.#poison();
    } finally {
      context.dispose();
    }

    const cappedPrinted = cap(printed.join("\n"), this.#limits.maxPrintedBytes);
    const cappedResult = result === null ? null : cap(result, this.#limits.maxResultBytes);
    // A run the interpreter only survived by being cut short leaves it unusable, and it is
    // reported rather than cleaned up: see `poisoned` in the outcome.
    const poisoned = error !== null && /out of memory|interrupted/.test(error.message);
    if (poisoned) {
      this.#poisoned = true;
      this.#poison();
    }

    return {
      printed: cappedPrinted.text,
      result: cappedResult?.text ?? null,
      error,
      poisoned,
      ms: Math.round(performance.now() - started),
      calls: counts.calls,
      truncated: cappedPrinted.truncated || (cappedResult?.truncated ?? false),
    };
  }

  #isSyntaxError(context: QuickJSContext, handle: QuickJSHandle): boolean {
    const value = context.dump(handle) as { name?: unknown } | undefined;
    return value?.name === "SyntaxError";
  }

  #describe(context: QuickJSContext, handle: QuickJSHandle): SandboxError {
    const dumped = context.dump(handle) as
      | { name?: unknown; message?: unknown; stack?: unknown }
      | undefined;
    return {
      name: typeof dumped?.name === "string" ? dumped.name : "Error",
      message: typeof dumped?.message === "string" ? dumped.message : String(dumped),
      stack: typeof dumped?.stack === "string" ? dumped.stack : null,
    };
  }

  #stringify(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }

  /** Forgets the interpreter. The host calls this when the worker it lives in goes away. */
  dispose(): void {
    this.#poison();
  }
}

export const sandboxDefaults = DEFAULTS;
