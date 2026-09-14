/**
 * The Kuna engine presented as an `AnalysisSource`.
 *
 * This file is the whole translation. Above it, the workspace renders functions
 * and decompiled C without knowing where they came from. Below it, `driver.ts`
 * owns the Worker, the WASI shim and the wasm.
 *
 * **What Kuna answers, and what it does not.** It inventories a binary and it
 * decompiles a function. It has no strings table, no section headers, no
 * import/export lists and no disassembly. Those are declared absent rather than
 * served empty, so the workspace hides them instead of drawing tables that would
 * claim this binary has no imports — a claim nothing here is in a position to
 * make.
 *
 * **What it cannot do about progress.** A run is one call into WebAssembly that
 * returns when it is finished. There is no fraction to report, so none is
 * reported: the scan says `null` from the first state to the last and the
 * overlay stays indeterminate, which is the truth about an opaque call.
 */

import type { FormatMatch } from "../../detect-format";
import {
  kunaAvailable,
  KunaWorkerCancelledError,
  openKunaSession,
  type KunaFunction,
  type KunaResult,
} from "./driver";
import type {
  AnalysisSource,
  AnalysisUnit,
  FunctionCode,
  FunctionRef,
  NavigatorNode,
  ScanOutcome,
  ScanState,
  UnitAnalysis,
} from "../types";

/**
 * Where the engine's own entries stop being the user's problem.
 *
 * `plt` and `thunk` are the engine telling the truth about what it found: an
 * import stub and a lone jump are entries, not functions. They are real and
 * they are listed, but below the code someone came to read, because the first
 * thing in the column should be the thing the binary does.
 */
const STUB_KINDS: readonly KunaFunction["kind"][] = ["plt", "thunk"];

function isStub(entry: KunaFunction): boolean {
  return STUB_KINDS.includes(entry.kind);
}

/** The C the engine produced, one entry per line, with no addresses to give. */
function toCodeLines(code: string): FunctionCode["lines"] {
  return code.split("\n").map((text) => ({ address: 0, text }));
}

/**
 * The harness always hands the binary to the guest at this path, so the engine's
 * own error messages name it. The fact is right; the name is the harness's and
 * means nothing to anyone reading the column.
 */
const GUEST_BINARY_PATH = "/work/input.bin";

function inTheUsersTerms(message: string, fileName: string): string {
  return message.split(GUEST_BINARY_PATH).join(fileName);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface KunaSourceOptions {
  /** Overridable so the analysis check can drive the mapping without a browser. */
  readonly available?: () => Promise<boolean>;
}

/**
 * Whether Kuna can be used for this file at all.
 *
 * Checked by the caller before choosing a source, so the answer is available
 * before a source is constructed.
 */
export function kunaCanAnalyze(format: FormatMatch, options: KunaSourceOptions = {}): Promise<boolean> {
  // An APK is a container: its native libraries are separate executables and its
  // dex is Rasc's, so it is not this engine's shape even when the artifacts are
  // present.
  if (format.engine !== "kuna") return Promise.resolve(false);
  return (options.available ?? kunaAvailable)();
}

export function createKunaSource(file: File, format: FormatMatch): AnalysisSource {
  const unit: AnalysisUnit = {
    id: "native:main",
    kind: "native",
    label: file.name,
    detail: format.detail,
    engine: "kuna",
  };

  const analysis = createKunaUnit(file, format, unit);
  return {
    units: [unit],
    primaryUnitId: unit.id,
    unit: (id) => {
      if (id !== unit.id) throw new Error(`Unknown analysis unit: ${id}`);
      return analysis;
    },
    stop: () => analysis.stop(),
  };
}

function createKunaUnit(file: File, format: FormatMatch, unit: AnalysisUnit): UnitAnalysis {
  const session = openKunaSession();

  let functions: readonly FunctionRef[] = [];
  let engineEntries = new Map<string, KunaFunction>();
  let revision = 0;
  let aborted = false;
  let facts: UnitAnalysis["facts"] extends () => infer R ? R : never = {
    format: format.label,
    architecture: format.detail,
    hash: "—",
    size: file.size,
    workerMemory: null,
  };

  const bump = () => {
    revision += 1;
  };

  /** Engine id to our id. Addresses are what the engine can address by. */
  const idFor = (address: number) => `fn:${address.toString(16)}`;

  function rows(): readonly FunctionRef[] {
    return functions;
  }

  return {
    unit,
    // The engine inventories and decompiles. Everything else is absent, and
    // saying so is what keeps the workspace from drawing tables that would read
    // as facts about this binary.
    capabilities: [],

    async scan(onState: (state: ScanState) => void): Promise<ScanOutcome> {
      aborted = false;
      // The engine reports nothing while it runs, so the only honest states are
      // "working" and "done". No fraction appears at any point.
      onState({ phase: "reading-symbols", fraction: null, discovered: 0, message: null });

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (aborted) return "stopped";

        const inventory = await session.load(bytes);
        if (aborted) return "stopped";

        const entries = inventory.functions ?? [];
        engineEntries = new Map(entries.map((entry) => [idFor(entry.address), entry]));

        // Real code first, then the stubs the engine also found. Both keep the
        // engine's own order within their group.
        functions = [
          ...entries.filter((entry) => !isStub(entry)),
          ...entries.filter(isStub),
        ].map((entry) => ({
          id: idFor(entry.address),
          name: entry.name,
          aliases: entry.aliases ?? [],
          address: entry.address,
          size: entry.size,
          // The engine resolves symbols itself, so it cannot say which came from
          // a symbol table and which it discovered. Both are its answer.
          origin: "symbol" as const,
        }));

        facts = {
          format: format.label,
          architecture: format.detail,
          hash: await sha256(bytes),
          size: bytes.byteLength,
          workerMemory: null,
        };

        bump();
        onState({
          phase: "ready",
          fraction: null,
          discovered: functions.length,
          // A binary the engine could read but found nothing in is not a
          // failure, and it is not obvious either. Saying so is the difference
          // between an empty column and a wrong-looking one.
          message:
            functions.length === 0
              ? "The engine read this file and found no functions in it."
              : null,
        });
        return "ready";
      } catch (error) {
        bump();

        /*
         * A cancel is a decision someone made, not the engine failing. It is also
         * what terminating the Worker looks like from here: the call that was in
         * flight rejects because the Worker that owed the answer no longer
         * exists. Reporting either as a failure would tell the user their binary
         * was broken when they pressed stop.
         */
        if (aborted || error instanceof KunaWorkerCancelledError) {
          onState({ phase: "stopped", fraction: null, discovered: functions.length, message: null });
          return "stopped";
        }

        onState({
          phase: "failed",
          fraction: null,
          discovered: functions.length,
          /*
           * The engine's own words. "could not build an architecture … Invalid
           * ELF header size or alignment" is not elegant, but it is true, it
           * names the actual problem, and it is what someone would search for.
           * Rewriting it into something friendlier would throw away the only
           * specific thing the screen can say.
           */
          message: inTheUsersTerms(error instanceof Error ? error.message : String(error), file.name),
        });
        throw error;
      }
    },

    stop() {
      // The engine cannot be asked to stop: WASI runs to completion once it
      // starts. Terminating the Worker is the only way to interrupt it, and the
      // client rebuilds a clean one so the next request still works.
      aborted = true;
      session.cancel();
      bump();
    },

    functions: rows,
    // Native code has no classes. This is a real absence, not a gap.
    classes: () => [],

    navigator(): readonly NavigatorNode[] {
      return rows().map((fn) => {
        const entry = engineEntries.get(fn.id);
        const stub = entry !== undefined && isStub(entry);
        return {
          id: fn.id,
          label: fn.name,
          // The kind is the engine's, and it is the difference between a
          // function and an import stub pointing at one.
          detail: stub ? `${fn.address.toString(16).padStart(8, "0")} · ${entry.kind}` : fn.address.toString(16).padStart(8, "0"),
          kind: "function" as const,
          depth: 0,
          expandable: false,
          expanded: false,
          classId: null,
          functionId: fn.id,
        };
      });
    },

    toggle() {
      // A flat list has nothing to expand.
    },

    async decompile(functionId: string): Promise<FunctionCode> {
      const entry = engineEntries.get(functionId);
      if (entry === undefined) throw new Error(`Unknown function: ${functionId}`);

      const result: KunaResult = await session.decompile(entry.address_hex);
      if (result.code === null) {
        throw new Error(result.error ?? `The engine produced no code for ${entry.name}.`);
      }
      return { functionId, language: "c", lines: toCodeLines(result.code) };
    },

    async disassemble() {
      throw new Error("Kuna does not disassemble; this unit declares no disassembly capability.");
    },

    strings: () => [],
    sections: () => [],
    imports: () => [],
    exports: () => [],
    facts: () => facts,
    revision: () => revision,

    /** Native code has no classes to read, so there is nothing to prepare. */
    prepareClass(): Promise<void> {
      return Promise.resolve();
    },
  };
}
