/**
 * The analysis surface an engine implements.
 *
 * Nothing in this file knows about Kuna, Rasc, WebAssembly or Workers, and
 * nothing outside `lib/analysis/` calls it right now: the UI that used to render
 * an `AnalysisSource` was removed with the workspace. It is kept because it is the
 * boundary an engine is reached through, and because `npm run check:analysis`
 * still holds the adapters behind it to it.
 *
 * Two rules shape the shape of this interface:
 *
 *  - Large collections are never returned by reference into reactive state. The
 *    source owns its arrays and hands out read-only views; a caller subscribes to
 *    `revision()` and re-reads what it needs.
 *  - Scanning is incremental. A binary is usable long before it is fully
 *    analysed, so discovery reports progress instead of returning one finished
 *    result set.
 */

import type { EngineId } from "../detect-format";

/** One analysable unit. A plain ELF has one; an APK has a DEX unit plus one per native library. */
export interface AnalysisUnit {
  readonly id: string;
  readonly kind: "dex" | "native";
  /** Shown in the source switcher, for example `DEX` or `libfoo.so`. */
  readonly label: string;
  /** Secondary line, for example the ABI directory or the slice name. */
  readonly detail: string;
  readonly engine: EngineId;
}

export type ScanPhase = "reading-symbols" | "discovering" | "ready" | "stopped" | "failed";

export interface ScanState {
  readonly phase: ScanPhase;
  /** A real fraction in `[0, 1]`, or `null` when the engine cannot report one. */
  readonly fraction: number | null;
  readonly discovered: number;
  /**
   * What to tell the user, when there is something to tell.
   *
   * A failed scan and a scan that found nothing both end with an empty column,
   * and an empty column explains nothing: it looks the same whether the engine
   * is still starting, found no functions, or could not read the file at all.
   * This is where the difference is said out loud.
   */
  readonly message: string | null;
}

export type ScanOutcome = "ready" | "stopped" | "failed";

export interface FunctionRef {
  readonly id: string;
  readonly name: string;
  /**
   * Other names the same function answers to.
   *
   * A decompiler prints whichever name it resolved, which is not always the one
   * the inventory lists first — Kuna reports `main` with `sub_1198` beside it and
   * may print either. Without these, a call site is unjumpable about half the
   * time and there is no way to tell which half.
   */
  readonly aliases: readonly string[];
  readonly address: number;
  readonly size: number;
  /** `symbol` came from the symbol table, `discovered` from code scanning. */
  readonly origin: "symbol" | "discovered";
}

/** A row of the navigator. The source flattens its own tree so the list can be virtualised. */
export interface NavigatorNode {
  readonly id: string;
  readonly label: string;
  readonly kind: "package" | "class" | "method" | "function";
  /** Trailing detail: an address, or a method count on a class. */
  readonly detail: string;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** Set on a class row, so selecting it can open that class. */
  readonly classId: string | null;
  /** Set on a method or function row, so selecting it can open that code. */
  readonly functionId: string | null;
}

export interface CodeLine {
  readonly address: number;
  readonly text: string;
}

/**
 * The languages an engine can hand back.
 *
 * The view highlights what it is given and links call sites by name, so it has to
 * know which grammar it is looking at. Two is the whole list because the two
 * engines answer in two languages; a third would be a third engine.
 */
export type CodeLanguage = "c" | "java";

/**
 * A class and the members it holds, in source order.
 *
 * Tab granularity follows the language: a Java method read on its own has no
 * context, so the unit the UI opens is the class. The order is the author's, not
 * alphabetical, because that is how the code reads.
 */
export interface ClassRef {
  readonly id: string;
  readonly qualifiedName: string;
  readonly detail: string;
  readonly members: readonly string[];
  /**
   * The part of the class that no member owns: the package, the imports, the
   * declaration and the fields.
   *
   * A Java class is one document, and a view that showed only its methods would
   * hide the fields and imports that make those methods readable — which is the
   * whole reason a class is the unit rather than a method. Empty for an engine
   * whose unit is already a function. It is filled from the same read that
   * produces `members`, because both are facts about that one document.
   */
  readonly preamble: readonly CodeLine[];
  /** What follows the last member: in practice, the class's closing brace. */
  readonly epilogue: readonly CodeLine[];
}

export interface FunctionCode {
  readonly functionId: string;
  readonly language: CodeLanguage;
  readonly lines: readonly CodeLine[];
}

export interface DisassemblyLine {
  readonly address: number;
  readonly bytes: string;
  readonly text: string;
}

export interface Disassembly {
  readonly functionId: string;
  readonly lines: readonly DisassemblyLine[];
}

export interface StringEntry {
  readonly id: string;
  readonly address: number;
  readonly value: string;
  /**
   * How many places use it, `0` when the engine counted and found none, and `null` when the
   * engine has not counted. The two are not the same claim: "nothing uses this" is an answer
   * only an engine that looked can give, and a zero that stands for "nobody asked" is the
   * kind of plausible number this application refuses to show.
   */
  readonly xrefs: number | null;
  /** The function that uses this string, so the STRINGS view can jump to it. */
  readonly functionId: string | null;
}

export interface SectionEntry {
  readonly name: string;
  readonly address: number;
  readonly size: number;
  readonly flags: string;
}

/** A symbol the unit takes from elsewhere, or one it offers. Same shape either way. */
export interface SymbolEntry {
  readonly name: string;
  readonly module: string;
}

export interface FileFacts {
  readonly format: string;
  readonly architecture: string;
  readonly hash: string;
  readonly size: number;
  /**
   * How much memory the analysis is holding, when the engine can say. Null means
   * nobody knows, and the row is left out: an invented figure here would be a
   * number the user has no way to check.
   */
  readonly workerMemory: string | null;
}

/**
 * What a unit's engine can answer.
 *
 * An empty collection and an unsupported one look identical from the outside,
 * and they are not the same thing: "this binary has no imports" and "the engine
 * cannot list imports" call for different screens. Without this, a real engine
 * that answers three of the six questions would render three empty tables — an
 * empty table is a claim, and it would be a false one.
 */
export type AnalysisCapability =
  | "classes"
  | "strings"
  | "sections"
  | "imports"
  | "exports"
  | "disassembly";

/** Per-unit view of an analysis. All collections are owned by the source. */
export interface UnitAnalysis {
  readonly unit: AnalysisUnit;
  /** The subset of the surface this unit can actually answer. */
  readonly capabilities: readonly AnalysisCapability[];

  /** Runs discovery to completion, reporting state as it goes. Resolves with the outcome. */
  scan(onState: (state: ScanState) => void): Promise<ScanOutcome>;
  /** Aborts this unit's scan. Results discovered so far are kept. */
  stop(): void;

  functions(): readonly FunctionRef[];
  /** Empty when the language has no classes, which is every native unit. */
  classes(): readonly ClassRef[];
  /** Flattened visible navigator rows. */
  navigator(): readonly NavigatorNode[];
  toggle(nodeId: string): void;

  /**
   * Reads the document a class stands for.
   *
   * A Java engine delivers a class as one source text and can hand back a method
   * from it afterwards; which methods it holds is a fact about that text, so it
   * does not exist until the class has been read. Engines whose unit is already a
   * function — every native one — have nothing to do here and resolve at once.
   */
  prepareClass(classId: string): Promise<void>;

  decompile(functionId: string): Promise<FunctionCode>;
  disassemble(functionId: string): Promise<Disassembly>;

  strings(): readonly StringEntry[];
  sections(): readonly SectionEntry[];
  imports(): readonly SymbolEntry[];
  exports(): readonly SymbolEntry[];
  facts(): FileFacts;

  /**
   * How many strings the unit holds, when the engine can say it without reading them.
   *
   * A table of half a million values is not something a host should have to receive in
   * order to count, and the count is usually a header field. Absent when the engine can
   * only answer by producing the table — in which case `strings()` is the count.
   */
  stringTotal?(): number | undefined;

  /**
   * The strings matching a search, when the table is too large to hand over whole.
   *
   * `query` is a case-insensitive substring, matched by the engine, so the rows a reader
   * sees are the rows a filter over the whole table would have shown. Absent when the
   * unit's table is small enough to hold, which is when the view filters it itself.
   */
  searchStrings?(query: string, limit: number): Promise<readonly StringEntry[]>;

  /**
   * Which classes use a string, when the engine can search for its references.
   *
   * The question behind the strings table's jump. `member` is the engine's own name for
   * what matched (`Lcom/foo/Bar;->baz`), kept beside the class so a caller can say what it
   * found even when the class is not one this unit can open. Empty means the engine
   * searched and nothing uses it, which is an answer; absent means nobody asked.
   *
   * `functionId` is the method inside the *first* class that can be opened, which is the
   * one a caller jumps to and therefore the only one whose member list is worth reading:
   * a popular string has hundreds of users, and resolving each would be a decompilation
   * each. Null when the engine named a method this unit cannot place.
   */
  findReferences?(
    value: string,
  ): Promise<readonly { classId: string | null; functionId: string | null; member: string }[]>;

  /**
   * Reads how many places use each string, when the engine can say it in one pass.
   *
   * A count per row would be a scan of the whole archive each (22 ms measured), so an engine
   * that can answer answers once for every string at a time. Asked for when a strings table
   * is opened rather than when the unit is, because the table may never be opened.
   */
  loadStringXrefs?(): Promise<void>;

  /** Bumped whenever any collection above changes, so the UI knows to re-read. */
  revision(): number;
}

export interface AnalysisSource {
  readonly units: readonly AnalysisUnit[];
  readonly primaryUnitId: string;
  unit(id: string): UnitAnalysis;
  /** Aborts whichever scan is currently running. */
  stop(): void;
}

/** Whether a unit's engine can answer a given part of the surface. */
export function supports(analysis: UnitAnalysis, capability: AnalysisCapability): boolean {
  return analysis.capabilities.includes(capability);
}

export function unitLabel(units: readonly AnalysisUnit[], id: string): string {
  return units.find((unit) => unit.id === id)?.label ?? id;
}

export function formatAddress(address: number, width = 8): string {
  return `0x${address.toString(16).padStart(width, "0")}`;
}
