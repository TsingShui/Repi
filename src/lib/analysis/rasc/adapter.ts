/**
 * The Rasc engine presented as an `AnalysisSource`.
 *
 * This file is the whole translation. Above it, the workspace renders a class
 * tree and decompiled Java without knowing where they came from. Below it,
 * `driver.ts` owns the Worker, the wasm and the archive.
 *
 * **What Rasc answers, and what it does not.** It lists the classes an archive
 * defines and decompiles one of them. It has no strings table, no section
 * headers, no import/export lists and no disassembly — those are declared absent
 * rather than served empty, so the workspace hides them instead of drawing tables
 * that would claim this archive has no imports, which nothing here is in a
 * position to say.
 *
 * **What it cannot do about progress.** A run is one call into WebAssembly that
 * returns when it is finished. There is no fraction to report, so none is
 * reported: the scan says `null` from the first state to the last and the overlay
 * stays indeterminate, which is the truth about an opaque call.
 *
 * **The member list arrives with the class.** Rasc prints a class as one Java
 * document; which methods it holds is a fact about that document, so it does not
 * exist until the class has been read. `prepareClass` is that read, and the
 * navigator's method rows appear once it has happened.
 */

import { formatBytes, type FormatMatch } from "../../detect-format";
import { sha256File } from "../../sha256";


/**
 * One class, as `classes --json` reports it.
 *
 * The engine reports the descriptor and the dotted name; the package and the
 * simple name are read out of the dotted name here, because they are how the
 * column groups things rather than facts the engine has a separate opinion about.
 */
interface ClassRow {
  readonly dexName: string;
  readonly descriptor: string;
  readonly javaName: string;
  readonly packageName: string;
  readonly simpleName: string;
}

/** One record of the index, or null for a line that is not one. */
function parseClassRecord(line: string): ClassRow | null {
  if (line.length === 0) return null;
  let record: { dex?: unknown; descriptor?: unknown; name?: unknown };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    // A payload that is not records at all is reported by the caller, which is the
    // only place that can say what the engine actually printed.
    return null;
  }
  if (typeof record.dex !== "string" || typeof record.descriptor !== "string" || typeof record.name !== "string") {
    return null;
  }
  const cut = record.name.lastIndexOf(".");
  return {
    dexName: record.dex,
    descriptor: record.descriptor,
    javaName: record.name,
    packageName: cut === -1 ? "" : record.name.slice(0, cut),
    simpleName: cut === -1 ? record.name : record.name.slice(cut + 1),
  };
}
import { openRascSession, rascAvailable, RascCancelledError, type RascSession } from "./driver";
import type {
  AnalysisSource,
  AnalysisUnit,
  ClassRef,
  CodeLine,
  FileFacts,
  SectionEntry,
  StringEntry,
  FunctionCode,
  FunctionRef,
  NavigatorNode,
  ScanOutcome,
  ScanState,
  UnitAnalysis,
} from "../types";

/** A class id is the descriptor, which is what `getclass` takes back. */
function classIdOf(row: ClassRow): string {
  return `class:${row.descriptor}`;
}

function packageIdOf(packageName: string): string {
  return `pkg:${packageName}`;
}

/** A method's identity is its position in the class document, which is stable. */
function methodIdOf(classId: string, index: number): string {
  return `method:${classId}#${index}`;
}

function classIdFromMethodId(methodId: string): string {
  const hash = methodId.lastIndexOf("#");
  return hash === -1 ? methodId : methodId.slice("method:".length, hash);
}

function toLines(lines: readonly string[]): readonly CodeLine[] {
  return lines.map((text) => ({ address: 0, text }));
}

interface ParsedClass {
  readonly preamble: readonly string[];
  readonly members: readonly ClassMember[];
  readonly epilogue: readonly string[];
  readonly methods: readonly FunctionRef[];
}

/** One member of a class, as the engine's outline reports it. */
interface ClassMember {
  readonly name: string;
  readonly lines: readonly string[];
}

/** One part of the outline: a declaration, or the header/footer no declaration owns. */
interface OutlinePart {
  readonly name: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The decompiled class, split where the engine said its parts are.
 *
 * `getclass --outline` writes one record and then the document exactly as the
 * plain command prints it, so the reading here is a slice per part rather than a
 * scan of the source: the engine produced the document and knows where its members
 * begin, and a host that re-derives that is a second implementation of the rule
 * that can disagree with the first.
 */
function readOutline(payload: string): { parts: readonly OutlinePart[]; lines: readonly string[] } | null {
  const newline = payload.indexOf("\n");
  if (newline === -1) return null;

  let record: { members?: unknown };
  try {
    record = JSON.parse(payload.slice(0, newline)) as { members?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(record.members)) return null;

  const parts: OutlinePart[] = [];
  for (const entry of record.members) {
    if (typeof entry !== "object" || entry === null) return null;
    const part = entry as Record<string, unknown>;
    if (
      typeof part.name !== "string" ||
      typeof part.kind !== "string" ||
      typeof part.start !== "number" ||
      typeof part.end !== "number"
    ) {
      return null;
    }
    parts.push({ name: part.name, kind: part.kind, start: part.start, end: part.end });
  }
  return { parts, lines: payload.slice(newline + 1).split("\n") };
}

/** The number from a `strings --count` record. */
function countCountRecords(payload: string): number | null {
  const line = payload.split("\n").find((entry) => entry.length > 0);
  if (line === undefined) return null;
  try {
    const record = JSON.parse(line) as { count?: unknown };
    return typeof record.count === "number" ? record.count : null;
  } catch {
    return null;
  }
}

/**
 * One string, as `strings --json` reports it.
 *
 * The owner and the cross-reference count are not here: which code touches a string is
 * a `findrefs` query, not a table read, and inventing a zero for it would be a claim
 * that nothing does.
 */
function parseStringRecord(line: string): StringEntry | null {
  if (line.length === 0) return null;
  let record: { dex?: unknown; index?: unknown; value?: unknown };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return null;
  }
  if (typeof record.value !== "string" || typeof record.index !== "number") return null;
  return {
    id: `string:${String(record.dex ?? "classes.dex")}:${record.index}`,
    address: record.index,
    value: record.value,
    xrefs: null,
    functionId: null,
  };
}

/**
 * The archive's entries, as `entries --json` reports them.
 *
 * A ZIP compression method is a number in the record and a word in the table: the
 * column is read by a person, and `0` there would be a code they have to know.
 */
function parseEntries(payload: string): readonly SectionEntry[] {
  const entries: SectionEntry[] = [];
  for (const line of payload.split("\n")) {
    if (line.length === 0) continue;
    let record: { name?: unknown; method?: unknown; compressed?: unknown; uncompressed?: unknown; offset?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (
      typeof record.name !== "string" ||
      typeof record.uncompressed !== "number" ||
      typeof record.offset !== "number"
    ) {
      continue;
    }
    entries.push({
      name: record.name,
      address: record.offset,
      size: record.uncompressed,
      flags: record.method === 8 ? "deflate" : record.method === 0 ? "stored" : `method ${String(record.method)}`,
    });
  }
  return entries;
}

/** The message of a failed command, which `--outline` reports as a record. */
function errorRecord(payload: string): string | null {
  const line = payload.split("\n").find((entry) => entry.length > 0);
  if (line === undefined) return null;
  try {
    const record = JSON.parse(line) as { error?: unknown };
    return typeof record.error === "string" ? record.error : null;
  } catch {
    return null;
  }
}

/** Drops blank lines an outline range picked up at its edges, which are layout, not content. */
function trimBlankEnds(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end);
}

export interface RascSourceOptions {
  /** Overridable so a check can drive the availability answer. */
  readonly available?: () => Promise<boolean>;
}

/**
 * A load is one fetch and one instantiate; a run is one call. Both are short on
 * any fixture small enough to carry in a check suite, which would leave
 * cancelling a Rasc scan untestable: the work is finished before a stop can be
 * clicked. `?rascDelay=<ms>` holds a command's answer for that long, so the path
 * that matters — terminate the Worker mid-command and rebuild a clean one — can
 * be driven deterministically. It is a check seam and nothing else; the
 * application never passes it.
 */
export interface RascOptions {
  readonly delayMs: number;
}

const DEFAULT_OPTIONS: RascOptions = { delayMs: 0 };

export function readRascOptions(search: string): RascOptions {
  const raw = new URLSearchParams(search).get("rascDelay");
  const value = Number(raw);
  return raw !== null && Number.isFinite(value) && value > 0
    ? { delayMs: Math.floor(value) }
    : DEFAULT_OPTIONS;
}

/**
 * Whether Rasc can be used for this file at all.
 *
 * Checked by the caller before choosing a source, so the answer is available
 * before a source is constructed. Only the formats `detect-format.ts` routes to
 * this engine are its shape: a native binary is Kuna's, and an archive with no
 * DEX in it is nobody's.
 */
export function rascCanAnalyze(
  format: FormatMatch,
  options: RascSourceOptions = {},
): Promise<boolean> {
  if (format.engine !== "rasc") return Promise.resolve(false);
  return (options.available ?? rascAvailable)();
}

export function createRascSource(file: File, format: FormatMatch): AnalysisSource {
  const options = readRascOptions(typeof window === "undefined" ? "" : window.location.search);
  const unit: AnalysisUnit = {
    id: "dex",
    kind: "dex",
    label: "DEX",
    // With one unit there is no switcher to show this in, but the type wants it
    // and META is not the place to repeat the container.
    detail: format.id === "apk" ? "Android package" : "Dalvik bytecode",
    engine: "rasc",
  };

  const analysis = createRascUnit(file, format, unit, options);
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

function createRascUnit(
  file: File,
  format: FormatMatch,
  unit: AnalysisUnit,
  options: RascOptions,
): UnitAnalysis {
  const session: RascSession = openRascSession(file, { delayMs: options.delayMs });

  let rows: readonly ClassRow[] = [];
  let sections: readonly SectionEntry[] = [];
  /** How many strings the archive holds; the values themselves are fetched on search. */
  let stringTotal: number | null = null;
  /** How many methods use each string, by the id the model gives it. Empty until asked. */
  const stringXrefs = new Map<string, number>();
  let xrefsLoaded = false;
  let classRefs: readonly ClassRef[] = [];
  let revision = 0;
  let aborted = false;
  let memory: number | null = null;

  /** The package tree's open rows: packages and classes, by node id. */
  const expanded = new Set<string>();
  /** Classes whose source has been read, by class id. */
  const parsed = new Map<string, ParsedClass>();
  const preparing = new Map<string, Promise<ParsedClass>>();

  let facts: FileFacts = {
    format: format.label,
    architecture: "Dalvik bytecode",
    hash: "—",
    size: file.size,
    workerMemory: null,
  };

  const bump = () => {
    revision += 1;
  };

  /** One class as the workspace sees it: what the index says, plus what has been read. */
  function refFor(row: ClassRow): ClassRef {
    const id = classIdOf(row);
    const read = parsed.get(id);
    return {
      id,
      qualifiedName: row.javaName,
      detail: read === undefined ? "" : `${read.members.length} methods`,
      members: read === undefined ? [] : read.methods.map((method) => method.id),
      preamble: read === undefined ? [] : toLines(read.preamble),
      epilogue: read === undefined ? [] : toLines(read.epilogue),
    };
  }

  /** Rebuilds the class list the workspace reads, from the index and what is parsed. */
  function rebuildClasses(): void {
    classRefs = rows.map(refFor);
    bump();
  }

  /** Replaces one class's ref after it has been read, without rebuilding all of them. */
  function updateClass(id: string): void {
    const index = classRefs.findIndex((entry) => entry.id === id);
    if (index === -1) {
      bump();
      return;
    }
    const next = classRefs.slice();
    next[index] = refFor(rows[index]!);
    classRefs = next;
    bump();
  }

  function rowFor(classId: string): ClassRow | null {
    return rows.find((row) => classIdOf(row) === classId) ?? null;
  }

  /**
   * Reads a class into members, once.
   *
   * Concurrent callers share one command: opening a class from the tree and
   * opening it as a tab are two intentions that land on the same read, and a
   * second `getclass` for the same class would be a second wait for the same
   * answer.
   */
  function prepare(classId: string): Promise<ParsedClass> {
    const read = parsed.get(classId);
    if (read !== undefined) return Promise.resolve(read);

    const inFlight = preparing.get(classId);
    if (inFlight !== undefined) return inFlight;

    const row = rowFor(classId);
    if (row === null) return Promise.reject(new Error(`Unknown class: ${classId}`));

    const task = (async (): Promise<ParsedClass> => {
      // The descriptor rather than the dotted name: `getclass` normalises both,
      // and the descriptor is the one that cannot be misread.
      const { code, output } = await session.run(["getclass", "--outline", file.name, row.descriptor]);
      const text = new TextDecoder().decode(output);

      if (code !== 0) {
        throw new Error(errorRecord(text) ?? text.trim() ?? `The engine exited with code ${code}.`);
      }

      const outlined = readOutline(text);
      if (outlined === null) {
        throw new Error("The engine's outline of this class could not be read.");
      }

      const slice = (part: OutlinePart) => outlined.lines.slice(part.start - 1, part.end);
      const header = outlined.parts.find((part) => part.kind === "header");
      const footer = outlined.parts.find((part) => part.kind === "footer");
      // Everything that is not a structural part is a declaration the column can
      // list; the two the engine reserves are the class's own opening and closing.
      const members: ClassMember[] = outlined.parts
        .filter((part) => part.kind !== "header" && part.kind !== "footer")
        .map((part) => ({ name: part.name, lines: trimBlankEnds(slice(part)) }));

      const methods: FunctionRef[] = members.map((member, index) => ({
        id: methodIdOf(classId, index),
        name: member.name,
        // The engine prints whichever name it resolved; it has no aliases to give.
        aliases: [],
        // A Java method has no address and no size of its own: the engine reports
        // neither, and a zero here is never shown because nothing asks a Java
        // member for either.
        address: 0,
        size: 0,
        origin: "symbol",
      }));

      const result: ParsedClass = {
        preamble: header === undefined ? [] : trimBlankEnds(slice(header)),
        members,
        epilogue: footer === undefined ? [] : trimBlankEnds(slice(footer)),
        methods,
      };
      parsed.set(classId, result);
      preparing.delete(classId);
      updateClass(classId);
      return result;
    })();

    preparing.set(classId, task);
    task.catch(() => {
      if (preparing.get(classId) === task) preparing.delete(classId);
    });
    return task;
  }

  function methodLines(classId: string, index: number): readonly CodeLine[] | null {
    const read = parsed.get(classId);
    const member = read?.members[index];
    return member === undefined ? null : toLines(member.lines);
  }

  return {
    unit,
    // The engine lists classes, decompiles one, and can list what the archive holds and
    // every string in it. Imports, exports and disassembly are absent, and saying so is
    // what keeps the workspace from drawing tables that would read as facts about this
    // archive.
    capabilities: ["classes", "sections", "strings"],

    async scan(onState: (state: ScanState) => void): Promise<ScanOutcome> {
      aborted = false;
      // The engine reports nothing while it runs, so the only honest states are
      // "working" and "done". No fraction appears at any point.
      onState({ phase: "reading-symbols", fraction: null, discovered: 0, message: null });

      try {
        const decoder = new TextDecoder();
        const collected: ClassRow[] = [];
        let unreadable: string | null = null;
        let buffered = "";

        const take = (line: string): void => {
          if (line.length === 0) return;
          const row = parseClassRecord(line);
          if (row === null) {
            // A line this build cannot read means the engine's format moved. The
            // class list would be silently short, so it is said out loud instead.
            unreadable ??= line;
            return;
          }
          collected.push(row);
        };

        /*
         * The payload is streamed and split as it arrives: a class index for a
         * real APK is tens of megabytes, and collecting it whole only to split it
         * by line would hold it twice. Only the parsed rows are kept — which is
         * also why a stopped scan keeps what it found: the rows already parsed
         * are a real, ordered subset of the archive's classes.
         */
        const { code, memoryBytes } = await session.run(["classes", "--json", file.name], {
          onChunk: (bytes) => {
            buffered += decoder.decode(bytes, { stream: true });
            let newline = buffered.indexOf("\n");
            while (newline !== -1) {
              take(buffered.slice(0, newline));
              buffered = buffered.slice(newline + 1);
              newline = buffered.indexOf("\n");
            }
          },
          /*
           * The engine's own walk, one step per DEX entry. It is a real fraction over a
           * total it knew before it started, so the overlay shows it rather than an
           * indeterminate bar — and inside one entry the engine says nothing, which the
           * overlay says too by having nothing to show.
           */
          onProgress: (done, total) => {
            if (total <= 0) return;
            onState({
              phase: "discovering",
              fraction: done / total,
              discovered: collected.length,
              message: null,
            });
          },
        });
        buffered += decoder.decode();
        take(buffered);

        memory = memoryBytes;
        rows = collected;
        rebuildClasses();
        facts = {
          ...facts,
          workerMemory: memory === null ? null : formatBytes(memory),
        };

        if (code !== 0) {
          // The index is asked for as records, so a failure is one - carrying the
          // engine's own message, which the text mode prints with an `Error: ` prefix.
          throw new Error(errorRecord(unreadable ?? "") ?? unreadable ?? `The engine exited with code ${code}.`);
        }

        /*
         * What the archive holds. It is the same walk's central directory, so it costs
         * one cheap command and it is the only part of the readout an APK can answer
         * beyond its format facts: the entries are what an archive has instead of
         * sections, and an entry's local header offset is its address in the file.
         */
        const listing = await session.run(["entries", "--json", file.name]);
        if (listing.code === 0) {
          sections = parseEntries(new TextDecoder().decode(listing.output));
        }

        /*
         * The archive's vocabulary, counted and not fetched. A table of half a million
         * values is the largest thing this unit has and the one nobody looks at until
         * they search, so the count comes from the DEX headers (`strings --count`) and
         * the values arrive a page at a time from `searchStrings`. Moving the table into
         * the page to populate a list is 69 MB on the 126 MB corpus, for a tab that may
         * never be opened.
         */
        onState({ phase: "reading-symbols", fraction: null, discovered: rows.length, message: null });
        const counted = await session.run(["strings", "--json", "--count", file.name]);
        if (counted.code === 0) {
          stringTotal = countCountRecords(new TextDecoder().decode(counted.output));
        } else {
          throw new Error(
            errorRecord(new TextDecoder().decode(counted.output)) ??
              `The engine exited with code ${counted.code}.`,
          );
        }
        if (unreadable !== null) {
          throw new Error(`The engine printed a line this build cannot read: ${unreadable}`);
        }

        onState({
          phase: "ready",
          fraction: null,
          discovered: rows.length,
          // An archive the engine could read but found no classes in is not a
          // failure, and it is not obvious either. Saying so is the difference
          // between an empty column and a wrong-looking one.
          message:
            rows.length === 0 ? "The engine read this archive and found no classes in it." : null,
        });

        /*
         * The file's digest is the page's own work, not the engine's, and it is
         * not what the column is waiting for. Hashing a 300 MB archive is real
         * work done a chunk at a time; it lands in META when it lands, rather
         * than holding the class tree behind it.
         */
        void sha256File(file)
          .then((hash) => {
            facts = { ...facts, hash };
            bump();
          })
          .catch(() => {
            // A file the page cannot read is a file the engine has already read;
            // the readout keeps its dash rather than inventing a digest.
          });

        return "ready";
      } catch (error) {
        bump();

        /*
         * A cancel is a decision someone made, not the engine failing. It is also
         * what terminating the Worker looks like from here: the call that was in
         * flight rejects because the Worker that owed the answer no longer
         * exists. Reporting either as a failure would tell the user their file
         * was broken when they pressed stop.
         */
        if (aborted || error instanceof RascCancelledError) {
          onState({ phase: "stopped", fraction: null, discovered: rows.length, message: null });
          return "stopped";
        }

        onState({
          phase: "failed",
          fraction: null,
          discovered: rows.length,
          /*
           * The engine's own words. "EOCD not found" is not elegant, but it is
           * true, it names the actual problem, and it is what someone would
           * search for. Rewriting it into something friendlier would throw away
           * the only specific thing the screen can say.
           */
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    stop() {
      // The engine cannot be asked to stop: a run is one synchronous call into
      // WebAssembly. Terminating the Worker is the only way to interrupt it, and
      // the client rebuilds a clean one so the next command still works.
      aborted = true;
      session.cancel();
      bump();
    },

    functions(): readonly FunctionRef[] {
      const all: FunctionRef[] = [];
      for (const read of parsed.values()) all.push(...read.methods);
      return all;
    },

    classes(): readonly ClassRef[] {
      return classRefs;
    },

    navigator(): readonly NavigatorNode[] {
      // One row per package, its classes when it is open, and the methods of a
      // class that has been read. Packages are flattened rather than nested: the
      // engine reports a package per class, not a hierarchy, and inventing one
      // would put rows in the column that no engine fact corresponds to.
      const packages = new Map<string, ClassRow[]>();
      for (const row of rows) {
        const bucket = packages.get(row.packageName);
        if (bucket === undefined) packages.set(row.packageName, [row]);
        else bucket.push(row);
      }

      const nodes: NavigatorNode[] = [];
      for (const [packageName, classes] of packages) {
        const packageId = packageIdOf(packageName);
        const packageOpen = expanded.has(packageId);
        nodes.push({
          id: packageId,
          label: packageName === "" ? "(default package)" : packageName,
          kind: "package",
          detail: `${classes.length} classes`,
          depth: 0,
          expandable: true,
          expanded: packageOpen,
          classId: null,
          functionId: null,
        });
        if (!packageOpen) continue;

        for (const row of classes) {
          const classId = classIdOf(row);
          const open = expanded.has(classId);
          const read = parsed.get(classId);
          nodes.push({
            id: classId,
            label: row.simpleName,
            kind: "class",
            detail: read === undefined ? "" : `${read.members.length} methods`,
            depth: 1,
            expandable: true,
            expanded: open,
            classId,
            functionId: null,
          });
          if (!open || read === undefined) continue;

          for (const method of read.methods) {
            nodes.push({
              id: method.id,
              label: method.name,
              kind: "method",
              // A Java method has no address to show, and the signature is the
              // line below the row it opens.
              detail: "",
              depth: 2,
              expandable: false,
              expanded: false,
              classId,
              functionId: method.id,
            });
          }
        }
      }
      return nodes;
    },

    toggle(nodeId: string): void {
      if (nodeId.startsWith("method:")) return;

      if (expanded.has(nodeId)) {
        expanded.delete(nodeId);
        bump();
        return;
      }

      expanded.add(nodeId);
      bump();

      // Expanding a class means asking to see its methods, and the method list is
      // a fact about the class document. Reading it here is what makes the tree
      // fill in without a second click.
      if (nodeId.startsWith("class:")) {
        void prepare(nodeId).catch(() => {
          // A class that cannot be read says so in the code view, which is where
          // the read was asked for in the first place.
        });
      }
    },

    async prepareClass(classId: string): Promise<void> {
      await prepare(classId);
    },

    async decompile(functionId: string): Promise<FunctionCode> {
      if (functionId.startsWith("method:")) {
        const classId = classIdFromMethodId(functionId);
        const read = await prepare(classId);
        const index = read.methods.findIndex((method) => method.id === functionId);
        const lines = methodLines(classId, index);
        if (lines === null) throw new Error(`Unknown function: ${functionId}`);
        return { functionId, language: "java", lines };
      }

      // A class id asks for the whole document, which is what the member list is
      // read out of; the code view asks for members, never for this.
      const classId = functionId;
      const read = await prepare(classId);
      return {
        functionId,
        language: "java",
        lines: toLines([...read.preamble, ...read.members.flatMap((member) => member.lines), ...read.epilogue]),
      };
    },

    async disassemble() {
      throw new Error("Rasc does not disassemble; this unit declares no disassembly capability.");
    },

    // The whole table is never held: a search asks for the rows it wants, and this
    // stays empty so a view that reads it does not think the archive has no strings.
    strings: () => [],
    sections: () => sections,
    stringTotal: () => stringTotal ?? undefined,

    /**
     * Who uses a string, for the strings table's jump.
     *
     * `findrefs` reports a member as `Lcom/foo/Bar;->baz`, so the class is the part before
     * `->` and the class id is that descriptor - the same id the index hands out. A member
     * of a class this archive does not define (a call into the framework, a lambda the
     * index never listed) has no id, and saying so is better than not answering at all.
     */
    /**
     * One pass over the archive, counting references per string.
     *
     * `strings --xrefs` answers for every referenced string at once: 296 ms on the 126 MB
     * corpus, against 22 ms per row for asking one at a time. Asked for when a strings table
     * is opened, and asked once.
     */
    async loadStringXrefs(): Promise<void> {
      if (xrefsLoaded) return;
      xrefsLoaded = true;

      let text = "";
      const take = (line: string): void => {
        if (line.length === 0) return;
        let record: { dex?: unknown; index?: unknown; count?: unknown };
        try {
          record = JSON.parse(line) as typeof record;
        } catch {
          return;
        }
        if (typeof record.index !== "number" || typeof record.count !== "number") return;
        stringXrefs.set(`string:${String(record.dex ?? "classes.dex")}:${record.index}`, record.count);
      };

      const { code, output } = await session.run(["strings", "--json", "--xrefs", file.name], {
        onChunk: (bytes) => {
          text += new TextDecoder().decode(bytes, { stream: true });
          let newline = text.indexOf("\n");
          while (newline !== -1) {
            take(text.slice(0, newline));
            text = text.slice(newline + 1);
            newline = text.indexOf("\n");
          }
        },
      });
      take(text);
      if (code !== 0) {
        xrefsLoaded = false;
        throw new Error(errorRecord(new TextDecoder().decode(output)) ?? `The engine exited with code ${code}.`);
      }
      bump();
    },

    async findReferences(
      value: string,
    ): Promise<readonly { classId: string | null; functionId: string | null; member: string }[]> {
      const found: { classId: string | null; functionId: string | null; member: string }[] = [];
      let text = "";
      const take = (line: string): void => {
        if (line.length === 0) return;
        let record: { member?: unknown };
        try {
          record = JSON.parse(line) as typeof record;
        } catch {
          return;
        }
        if (typeof record.member !== "string") return;
        const arrow = record.member.indexOf("->");
        const descriptor = arrow === -1 ? record.member : record.member.slice(0, arrow);
        const classId = `class:${descriptor}`;
        found.push({
          classId: classRefs.some((entry) => entry.id === classId) ? classId : null,
          functionId: null,
          member: record.member,
        });
      };

      // The archive is `findrefs`'s own positional and the query kind is its subcommand, so
      // the file comes first: `findrefs --json <file> string <value>`.
      const { code, output } = await session.run(["findrefs", "--json", file.name, "string", value], {
        onChunk: (bytes) => {
          text += new TextDecoder().decode(bytes, { stream: true });
          let newline = text.indexOf("\n");
          while (newline !== -1) {
            take(text.slice(0, newline));
            text = text.slice(newline + 1);
            newline = text.indexOf("\n");
          }
        },
      });
      take(text);
      if (code !== 0) {
        throw new Error(errorRecord(new TextDecoder().decode(output)) ?? `The engine exited with code ${code}.`);
      }

      /*
       * The mark: the engine names the method, and the class's own document names it too,
       * so the member it reported is one of that class's members. Only the first class a
       * caller would open is read - a popular string has hundreds of users, and resolving
       * each would be a decompilation each - and a name that does not appear among the
       * members is left unmarked rather than guessed at.
       */
      const first = found.find((entry) => entry.classId !== null);
      if (first?.classId != null) {
        const arrow = first.member.indexOf("->");
        const name = arrow === -1 ? "" : first.member.slice(arrow + 2);
        const read = await prepare(first.classId).catch(() => null);
        const method = read?.methods.find((entry) => entry.name === name);
        if (method !== undefined) first.functionId = method.id;
      }
      return found;
    },

    async searchStrings(query: string, limit: number): Promise<readonly StringEntry[]> {
      const args = ["strings", "--json", "--limit", String(limit)];
      if (query.length > 0) args.push("--filter", query);
      args.push(file.name);

      const found: StringEntry[] = [];
      let text = "";
      const take = (line: string): void => {
        const entry = parseStringRecord(line);
        /*
         * The census, when it has been read. Zero only when it has: a string the census does
         * not name is one nothing references, which is an answer - and before the census
         * arrives the same absence means nobody has looked, which is not.
         */
        if (entry !== null) {
          const counted = stringXrefs.get(entry.id);
          found.push({ ...entry, xrefs: counted ?? (xrefsLoaded ? 0 : null) });
        }
      };
      const { code, output } = await session.run(args, {
        onChunk: (bytes) => {
          text += new TextDecoder().decode(bytes, { stream: true });
          let newline = text.indexOf("\n");
          while (newline !== -1) {
            take(text.slice(0, newline));
            text = text.slice(newline + 1);
            newline = text.indexOf("\n");
          }
        },
      });
      take(text);
      if (code !== 0) {
        throw new Error(errorRecord(new TextDecoder().decode(output)) ?? `The engine exited with code ${code}.`);
      }
      return found;
    },
    imports: () => [],
    exports: () => [],
    facts: () => facts,
    revision: () => revision,
  };
}
