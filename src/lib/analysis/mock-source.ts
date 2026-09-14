/**
 * A deterministic stand-in for a real engine.
 *
 * It exists so the workspace can be built, judged and regression-checked before
 * Kuna and Rasc are wired in. It implements the same contract a real adapter
 * will, including the parts that are easy to forget while prototyping:
 * progressive discovery, an abortable scan, a stripped binary with no symbols,
 * a deeply nested class tree, and containers with several analysis units.
 *
 * Test seams, read from the page URL so the smoke check can pin them:
 *   ?mockDelay=0        remove all artificial latency
 *   ?mockCount=120000   force a function count, for the large-list case
 *   ?mockSymbols=none   force a stripped binary
 *   ?mockWork=2400      pin a single decompile's duration, for the slow path
 */

import { formatBytes, type FormatMatch } from "../detect-format";
import { createRandom, hashString, type Random } from "./random";
import {
  className,
  generateCode,
  generateDisassembly,
  generateDexExports,
  generateDexImports,
  generateExports,
  generateImports,
  generateSections,
  type CachedString,
  generateStrings,
  methodName,
  nativeSymbolPool,
  packageNames,
  pseudoHash,
  strippedName,
} from "./mock-fixtures";
import type {
  AnalysisSource,
  AnalysisUnit,
  ClassRef,
  Disassembly,
  FileFacts,
  FunctionCode,
  FunctionRef,
  NavigatorNode,
  ScanOutcome,
  ScanState,
  SectionEntry,
  StringEntry,
  SymbolEntry,
  UnitAnalysis,
} from "./types";

export interface MockOptions {
  readonly delayScale: number;
  readonly functionCount: number | null;
  readonly stripped: boolean;
  /** Forces the long, mangled names that real C++ produces. */
  readonly longNames: boolean;
  /** Overrides one decompile's duration, so the long-running path can be driven. */
  readonly workMs: number | null;
}

const SYMBOL_READ_MS = 150;
const BATCH_MS = 55;
const DISCOVERY_BATCHES = 14;
const DECOMPILE_MS = 260;
const DISASSEMBLE_MS = 120;
const SYMBOL_LIMIT = 40;
const BASE_ADDRESS = 0x100000;

export function readMockOptions(search: string, fileName: string): MockOptions {
  const params = new URLSearchParams(search);
  const rawDelay = params.get("mockDelay");
  const rawCount = params.get("mockCount");
  const rawWork = params.get("mockWork");
  const delay = Number(rawDelay);
  const count = Number(rawCount);
  const work = Number(rawWork);

  return {
    delayScale: rawDelay !== null && Number.isFinite(delay) ? Math.max(0, delay) : 1,
    functionCount: rawCount !== null && Number.isFinite(count) && count > 0 ? Math.floor(count) : null,
    stripped: params.get("mockSymbols") === "none" || /strip/i.test(fileName),
    longNames: params.get("mockNames") === "long",
    workMs: rawWork !== null && Number.isFinite(work) && work >= 0 ? work : null,
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface DexClass {
  readonly id: string;
  readonly name: string;
  readonly methods: readonly FunctionRef[];
}

interface DexPackage {
  readonly id: string;
  readonly name: string;
  readonly classes: readonly DexClass[];
}

function unitTargetCount(size: number, override: number | null): number {
  if (override !== null) return override;
  return clamp(Math.round(size / 256), 8, 250_000);
}

/**
 * A name of the length real C++ produces.
 *
 * Mangled template names run to hundreds of characters, and the layout has to
 * survive them: a name that wraps makes a tab taller, which makes the whole
 * strip taller, which pushes the top bar out of shape. Reaching that on demand
 * would otherwise take a 116 MB binary and two minutes, so the mock can produce
 * it: `?mockNames=long`.
 */
function longName(index: number): string {
  return `__ZN4absl19functional_internal12InvokeObjectIZNS_18container_internal17FlatHashMapPolicyIN2v88internal8compiler10turboshaft13SnapshotTableINS2_7OpIndexENS2_12VariableDataEE$_${index}`;
}

function makeNativeFunction(
  seed: number,
  index: number,
  stripped: boolean,
  useLongNames: boolean,
): FunctionRef {
  const rng = createRandom(seed ^ Math.imul(index + 1, 0x9e3779b1));
  const address = BASE_ADDRESS + index * 0x30 + (index % 5) * 0x8;
  const pool = nativeSymbolPool();
  const fromSymbolTable = !stripped && index < SYMBOL_LIMIT;
  const baseName = fromSymbolTable ? (pool[index % pool.length] ?? `symbol_${index}`) : strippedName(address);
  const symbolName = useLongNames ? `${baseName}${longName(index)}` : baseName;

  return {
    id: `fn:${index.toString(16)}`,
    name: symbolName ?? strippedName(address),
    aliases: [],
    address,
    size: rng.pick([0x18, 0x24, 0x40, 0x5c, 0x88, 0xb4]),
    origin: fromSymbolTable ? "symbol" : "discovered",
  };
}

function buildDexTree(seed: number, target: number): readonly DexPackage[] {
  const rng = createRandom(seed ^ 0x1f83d9ab);
  const packageCount = clamp(Math.ceil(target / 120), 1, 48);
  const classesPerPackage = clamp(Math.ceil(target / packageCount / 12), 1, 24);
  const methodsPerClass = Math.max(1, Math.floor(target / (packageCount * classesPerPackage)));

  const names = packageNames(rng, packageCount);
  const packages: DexPackage[] = [];
  let functionIndex = 0;

  for (let packageIndex = 0; packageIndex < packageCount; packageIndex += 1) {
    const classes: DexClass[] = [];

    for (let classIndex = 0; classIndex < classesPerPackage; classIndex += 1) {
      const methods: FunctionRef[] = [];

      for (let methodIndex = 0; methodIndex < methodsPerClass; methodIndex += 1) {
        const address = BASE_ADDRESS + functionIndex * 0x14 + methodIndex * 0x4;
        methods.push({
          id: `fn:${functionIndex.toString(16)}`,
          name: `${methodName(rng)}${methodIndex === 0 ? "" : `_${methodIndex}`}`,
          aliases: [],
          address,
          size: rng.pick([0x14, 0x1c, 0x30, 0x48, 0x74]),
          origin: "symbol",
        });
        functionIndex += 1;
      }

      classes.push({
        // 包的**名字**会重复（名字来自一个池子），所以 id 必须用包的序号，
        // 否则两个包里的同类索引会撞成同一个 id，跳转就会落到错的类上。
        id: `class:${packageIndex}:${classIndex}`,
        name: `${className(rng)}${classIndex === 0 ? "" : classIndex}`,
        methods,
      });
    }

    packages.push({
      id: `pkg:${packageIndex}:${names[packageIndex]}`,
      name: names[packageIndex] ?? `package${packageIndex}`,
      classes,
    });
  }

  return packages;
}

function flattenDex(packages: readonly DexPackage[], expanded: ReadonlySet<string>): readonly NavigatorNode[] {
  const rows: NavigatorNode[] = [];

  for (const package_ of packages) {
    const packageOpen = expanded.has(package_.id);
    rows.push({
      id: package_.id,
      label: package_.name,
      kind: "package",
      detail: `${package_.classes.length} classes`,
      depth: 0,
      expandable: true,
      expanded: packageOpen,
      classId: null,
      functionId: null,
    });

    if (!packageOpen) continue;

    for (const class_ of package_.classes) {
      const classOpen = expanded.has(class_.id);
      rows.push({
        id: class_.id,
        label: class_.name,
        kind: "class",
        detail: `${class_.methods.length} methods`,
        depth: 1,
        expandable: true,
        expanded: classOpen,
        classId: class_.id,
        functionId: null,
      });

      if (!classOpen) continue;

      for (const method of class_.methods) {
        rows.push({
          id: method.id,
          label: method.name,
          kind: "method",
          detail: method.address.toString(16).padStart(8, "0"),
          depth: 2,
          expandable: false,
          expanded: false,
          classId: class_.id,
          functionId: method.id,
        });
      }
    }
  }

  return rows;
}

interface UnitHandle {
  readonly analysis: UnitAnalysis;
  readonly abort: () => void;
}

function createUnitAnalysis(
  unit: AnalysisUnit,
  size: number,
  options: MockOptions,
  fileSeed: number,
): UnitHandle {
  const seed = fileSeed ^ hashString(unit.id);
  const rng: Random = createRandom(seed);
  const target = unitTargetCount(size, options.functionCount);
  const functions: FunctionRef[] = [];
  const expanded = new Set<string>();
  const packages: readonly DexPackage[] = unit.kind === "dex" ? buildDexTree(seed, target) : [];

  if (unit.kind === "dex") {
    for (const package_ of packages) {
      for (const class_ of package_.classes) functions.push(...class_.methods);
    }
  }

  const symbolCount =
    unit.kind === "dex" ? functions.length : options.stripped ? 0 : Math.min(SYMBOL_LIMIT, target);

  let revision = 0;
  let aborted = false;
  let discoveryState: ScanState = { phase: "reading-symbols", fraction: null, discovered: 0, message: null };
  let stringsCache: readonly CachedString[] | null = null;
  let stringsBound: readonly StringEntry[] = [];
  let stringsBoundFor = -1;

  const sections: readonly SectionEntry[] =
    unit.kind === "dex"
      ? [
          { name: "header", address: 0, size: 0x70, flags: "R" },
          { name: "string_ids", address: 0x70, size: 0x1a40, flags: "R" },
          { name: "type_ids", address: 0x1ab0, size: 0x9c0, flags: "R" },
          { name: "proto_ids", address: 0x2470, size: 0x12c0, flags: "R" },
          { name: "method_ids", address: 0x3730, size: 0x2a80, flags: "R" },
          { name: "code_item", address: 0x61b0, size: Math.round(size * 0.7), flags: "RX" },
        ]
      : generateSections(rng, size);

  /*
   * 导入导出按语言分别生成。一个 DEX 的「导入」是它引用但不定义的类型，
   * 「导出」是它对外提供的公开 API；一个 .so 的「导入」是 libc/libssl 的符号，
   * 「导出」是它的 JNI 入口点。两者混在一个列表里会变成两种东西挤在一栏。
   */
  const imports: readonly SymbolEntry[] =
    unit.kind === "dex"
      ? generateDexImports(rng, clamp(Math.round(size / 60_000), 6, 40))
      : generateImports(rng, clamp(Math.round(size / 40_000), 8, 60));

  const exports: readonly SymbolEntry[] =
    unit.kind === "dex"
      ? generateDexExports(rng, clamp(Math.round(size / 400_000), 3, 20))
      : generateExports(rng, clamp(Math.round(size / 300_000), 2, 12));

  /** Java 的最小自足单位是类，所以契约要知道「一个类有哪些方法」。 */
  const classes: readonly ClassRef[] = packages.flatMap((package_) =>
    package_.classes.map((class_) => {
      const bytes = class_.methods.reduce((total, method) => total + method.size, 0);
      return {
        id: class_.id,
        qualifiedName: `${package_.name}.${class_.name}`,
        detail: `${class_.methods.length} methods · ${formatBytes(bytes)}`,
        members: class_.methods.map((method) => method.id),
        // 这些生成的方法彼此独立，没有一个共同的类文档，所以类的前后缀是空的 ——
        // 这正是 Rasc 与 mock 的差别：真实引擎交回来的是一整个类的源码。
        preamble: [],
        epilogue: [],
      };
    }),
  );

  const facts: FileFacts = {
    format: unit.kind === "dex" ? "DEX 0.35 content" : `${unit.detail} executable`,
    architecture: unit.kind === "dex" ? "Dalvik bytecode" : unit.detail,
    hash: pseudoHash(createRandom(seed ^ 0xa5a5a5a5)),
    size,
    workerMemory: formatBytes(Math.round(size * 2.4) + 16 * 1024 * 1024),
  };

  function growTo(count: number): void {
    while (functions.length < Math.min(count, target)) {
      functions.push(makeNativeFunction(seed, functions.length, options.stripped, options.longNames));
    }
  }

  function callableNames(): readonly string[] {
    const names = functions.slice(0, 64).map((entry) => entry.name);
    return names.length > 0 ? names : ["helper"];
  }

  const analysis: UnitAnalysis = {
    unit,
    capabilities:
      unit.kind === "dex"
        ? ["classes", "strings", "sections", "imports", "exports", "disassembly"]
        : ["strings", "sections", "imports", "exports", "disassembly"],

    async scan(onState): Promise<ScanOutcome> {
      aborted = false;

      onState({ phase: "reading-symbols", fraction: null, message: null, discovered: functions.length });
      await sleep(SYMBOL_READ_MS * options.delayScale);

      if (aborted) {
        onState(settle("stopped"));
        return "stopped";
      }

      if (unit.kind === "dex") {
        // A DEX parse is a table read, not a sweep, so it completes in one step
        // rather than reporting a fraction it does not really have.
        onState(settle("ready"));
        return "ready";
      }

      growTo(symbolCount);
      revision += 1;
      onState({ phase: "reading-symbols", fraction: null, message: null, discovered: functions.length });

      for (let batch = 1; batch <= DISCOVERY_BATCHES; batch += 1) {
        if (aborted) {
          onState(settle("stopped"));
          return "stopped";
        }

        const reached = symbolCount + Math.round(((target - symbolCount) * batch) / DISCOVERY_BATCHES);
        growTo(reached);
        revision += 1;

        // A real fraction, because native discovery really is a sweep over code.
        onState({
          phase: "discovering",
          fraction: target === 0 ? 1 : functions.length / target,
          message: null, discovered: functions.length,
        });

        await sleep(BATCH_MS * options.delayScale);
      }

      if (aborted) {
        onState(settle("stopped"));
        return "stopped";
      }

      onState(settle("ready"));
      return "ready";
    },

    stop(): void {
      aborted = true;
    },

    functions(): readonly FunctionRef[] {
      return functions;
    },

    classes(): readonly ClassRef[] {
      return classes;
    },

    navigator(): readonly NavigatorNode[] {
      if (unit.kind === "dex") return flattenDex(packages, expanded);

      // Native 没有类，所以类这一栏是空的 —— 粒度差异就体现在这里。
      return functions.map((function_) => ({
        id: function_.id,
        label: function_.name,
        kind: "function" as const,
        detail: function_.address.toString(16).padStart(8, "0"),
        depth: 0,
        expandable: false,
        expanded: false,
        classId: null,
        functionId: function_.id,
      }));
    },

    toggle(nodeId: string): void {
      if (expanded.has(nodeId)) expanded.delete(nodeId);
      else expanded.add(nodeId);
      revision += 1;
    },

    prepareClass(): Promise<void> {
      // 这个引擎的类从一开始就带着成员表：它生成的每个方法都是独立的，不存在
      // 一个需要先读出来才知道成员的类文档。
      return Promise.resolve();
    },

    async decompile(functionId: string): Promise<FunctionCode> {
      await sleep(options.workMs ?? DECOMPILE_MS * options.delayScale);
      if (aborted) throw new Error("Analysis was stopped");

      const function_ = functions.find((entry) => entry.id === functionId);
      if (!function_) throw new Error(`Unknown function: ${functionId}`);

      return {
        functionId,
        language: "c",
        lines: generateCode(createRandom(seed ^ hashString(functionId)), function_.name, function_.address, callableNames()),
      };
    },

    async disassemble(functionId: string): Promise<Disassembly> {
      await sleep(options.workMs ?? DISASSEMBLE_MS * options.delayScale);
      if (aborted) throw new Error("Analysis was stopped");

      const function_ = functions.find((entry) => entry.id === functionId);
      if (!function_) throw new Error(`Unknown function: ${functionId}`);

      return {
        functionId,
        lines: generateDisassembly(
          createRandom(seed ^ hashString(functionId) ^ 0x5bf03635),
          function_.address,
          function_.size,
          callableNames(),
        ),
      };
    },

    strings(): readonly StringEntry[] {
      // The table itself is stable: addresses, values and cross-references are
      // generated once, so scrolling never reshuffles. Only the owner is bound
      // late, and only when the number of discovered functions has changed.
      if (stringsCache === null) {
        const count = clamp(Math.round(size / 1024), 4, 60_000);
        stringsCache = generateStrings(createRandom(seed ^ 0x57a1c0de), count);
      }
      if (stringsBoundFor !== functions.length) {
        stringsBound = stringsCache.map((entry) => ({
          ...entry,
          functionId: functions.length === 0 ? null : functions[entry.ownerSlot % functions.length]!.id,
        }));
        stringsBoundFor = functions.length;
      }
      return stringsBound;
    },

    sections(): readonly SectionEntry[] {
      return sections;
    },

    imports(): readonly SymbolEntry[] {
      return imports;
    },

    exports(): readonly SymbolEntry[] {
      return exports;
    },

    facts(): FileFacts {
      return facts;
    },

    revision(): number {
      return revision;
    },
  };

  function settle(phase: "ready" | "stopped" | "failed"): ScanState {
    discoveryState = {
      phase,
      fraction: phase === "ready" ? 1 : discoveryState.fraction,
      message: null,
      discovered: functions.length,
    };
    revision += 1;
    return discoveryState;
  }

  return { analysis, abort: () => {
    aborted = true;
  } };
}

/** Derives the analysis units a container holds. DEX is one unit; native libraries are one each. */
export function unitsFor(format: FormatMatch, fileName: string, seed: number): readonly AnalysisUnit[] {
  const rng = createRandom(seed ^ 0x2f8b1c3d);

  switch (format.id) {
    case "apk": {
      const count = rng.int(1, 4);
      const abis = ["arm64-v8a", "armeabi-v7a"];
      const libraries = ["libnotes.so", "libcrypto.so", "libsync.so", "libcodec.so"].slice(0, count);

      return [
        { id: "dex", kind: "dex", label: "DEX", detail: "classes · dex", engine: "rasc" },
        ...libraries.map((name, index) => ({
          id: `native:${name}`,
          kind: "native" as const,
          label: name,
          detail: abis[index % abis.length] ?? "arm64-v8a",
          engine: "kuna" as const,
        })),
      ];
    }

    case "dex":
      return [{ id: "dex", kind: "dex", label: "DEX", detail: "Dalvik bytecode", engine: "rasc" }];

    case "macho-fat": {
      const slices = rng.chance(0.5) ? ["arm64", "x86_64"] : ["arm64", "arm64e", "x86_64"];
      return slices.map((slice) => ({
        id: `native:${slice}`,
        kind: "native" as const,
        label: slice,
        detail: "Mach-O slice",
        engine: "kuna" as const,
      }));
    }

    default:
      return [
        { id: "native:main", kind: "native", label: fileName, detail: format.detail, engine: "kuna" },
      ];
  }
}

export function createMockSource(file: File, format: FormatMatch): AnalysisSource {
  const options = readMockOptions(window.location.search, file.name);
  const fileSeed = hashString(`${file.name}:${file.size}`);

  const handles = new Map<string, UnitHandle>();
  for (const unit of unitsFor(format, file.name, fileSeed)) {
    handles.set(unit.id, createUnitAnalysis(unit, file.size, options, fileSeed));
  }

  const units = Array.from(handles.values(), (handle) => handle.analysis.unit);
  let active: UnitHandle | null = null;

  return {
    units,
    primaryUnitId: units[0]?.id ?? "",

    unit(id: string): UnitAnalysis {
      const handle = handles.get(id);
      if (!handle) throw new Error(`Unknown analysis unit: ${id}`);
      active = handle;
      return handle.analysis;
    },

    stop(): void {
      active?.abort();
    },
  };
}
