import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type {
  CodeLanguage,
  CodeLine,
  DisassemblyLine,
  FunctionCode,
  UnitAnalysis,
} from "../../../lib/analysis/types";
import { formatAddress } from "../../../lib/analysis/types";
import { highlightAsm, highlightC, highlightJava, type Token } from "../../../lib/highlight";
import { StructureField } from "../../home/structure-field";
import type { Tab } from "../workspace";

export interface CodeViewProps {
  readonly analysis: UnitAnalysis;
  readonly tab: Tab;
  readonly revision: number;
  readonly assembly: boolean;
  /** True while discovery runs, which is when the structure field is worth showing. */
  readonly busy: boolean;
  /** Reports a fetch that has run long enough to deserve the top bar's attention. */
  readonly onSlowOperation: (slow: boolean) => void;
  /** Opens the function a call site names. */
  readonly onJumpToFunction: (functionId: string) => void;
  /** Opens the class a qualified call site names. */
  readonly onJumpToClass: (classId: string) => void;
}

/** A single function decompiles quickly; a flash of progress is worse than none. */
const PENDING_DELAY_MS = 400;
/** Past this, the work stops looking instant and the top bar joins in. */
const SLOW_OPERATION_MS = 2000;
const CACHE_LIMIT = 40;
/**
 * Members are fetched together rather than one after another: a class of sixty
 * methods fetched in sequence is sixty round trips deep before anything appears.
 * The bound exists because a class can be large and the engine underneath may
 * serialise anyway.
 */
const FETCH_CONCURRENCY = 8;

interface Member {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly lines: readonly (CodeLine | DisassemblyLine)[];
}

/** Everything one tab renders: the class's own lines, its members, and its close. */
interface Document {
  readonly language: CodeLanguage;
  readonly preamble: readonly CodeLine[];
  readonly epilogue: readonly CodeLine[];
  readonly members: readonly Member[];
}

/** Where a highlighted call site goes. */
interface CallTarget {
  readonly kind: "function" | "class";
  readonly id: string;
}

function hasBytes(line: CodeLine | DisassemblyLine): line is DisassemblyLine {
  return "bytes" in line;
}

/**
 * One tab's code.
 *
 * A Java tab holds a whole class and every method in it, because a method read on
 * its own has no context — its fields, its siblings and its imports are what make
 * it readable. A native tab holds one function, because there is no enclosing
 * class and a function is already self-contained.
 *
 * The class's own part is rendered too. A Java engine returns a class as one
 * document, and
 * the fields and imports above the first method are not owned by any method; a
 * view that dropped them would be showing the methods without the context that
 * argued for class granularity in the first place.
 */
export function CodeView(props: CodeViewProps) {
  const [document, setDocument] = createSignal<Document>({
    language: "c",
    preamble: [],
    epilogue: [],
    members: [],
  });
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);

  const mode = (): "c" | "asm" => (props.assembly ? "asm" : "c");

  /** The class an id stands for, or null when the id is not a class in this unit. */
  function classFor(id: string | null): ReturnType<UnitAnalysis["classes"]>[number] | null {
    if (id === null) return null;
    return props.analysis.classes().find((entry) => entry.id === id) ?? null;
  }

  /** The class this tab stands for, or null when it is a native function. */
  const klass = () => (props.tab.kind === "class" ? classFor(props.tab.subject) : null);

  /*
   * Names in the code that the engine can actually open.
   *
   * A native call site prints a function name and the engine's inventory is the
   * index. A Java call site prints `Foo.bar(...)`, where `Foo` is a class the
   * index has and `bar` is a method of whichever class the receiver names — so
   * the receiver is what is resolved, and a name that resolves to nothing is left
   * as plain text rather than offered as a link that would go nowhere.
   */
  let targetCache: { revision: number; tab: string; targets: Map<string, CallTarget> } | null = null;

  function callTargets(): Map<string, CallTarget> {
    if (targetCache !== null && targetCache.revision === props.revision && targetCache.tab === props.tab.key) {
      return targetCache.targets;
    }

    const targets = new Map<string, CallTarget>();
    const own = klass();
    const all = props.analysis.classes();
    const functionsById = new Map(props.analysis.functions().map((entry) => [entry.id, entry]));

    if (own !== null) {
      // A Java tab links to its own methods by bare name, and to another class by
      // the receiver path. A bare name never resolves across classes: the same
      // method name exists in hundreds of them.
      for (const id of own.members) {
        const fn = functionsById.get(id);
        if (fn !== undefined && !targets.has(fn.name)) targets.set(fn.name, { kind: "function", id });
      }

      // Counting the simple names once is what keeps a 77,000-class index from
      // being rescanned per class: a name two classes share is not a resolution,
      // and the count is the whole test. A fully qualified receiver is unique by
      // construction, which is why the decompiler prints one.
      const shared = new Map<string, number>();
      for (const klass of all) {
        const simple = klass.qualifiedName.split(".").at(-1) ?? klass.qualifiedName;
        shared.set(simple, (shared.get(simple) ?? 0) + 1);
      }
      for (const klass of all) {
        if (klass.id === own.id) continue;
        targets.set(klass.qualifiedName, { kind: "class", id: klass.id });
        const simple = klass.qualifiedName.split(".").at(-1) ?? klass.qualifiedName;
        if (shared.get(simple) !== 1 || targets.has(simple)) continue;
        targets.set(simple, { kind: "class", id: klass.id });
      }
    }

    for (const fn of props.analysis.functions()) {
      if (!targets.has(fn.name)) targets.set(fn.name, { kind: "function", id: fn.id });
      for (const alias of fn.aliases) {
        if (!targets.has(alias)) targets.set(alias, { kind: "function", id: fn.id });
      }
    }

    targetCache = { revision: props.revision, tab: props.tab.key, targets };
    return targets;
  }

  /** Resolves a highlighted call token, which may carry its receiver's path. */
  function targetFor(token: Token): CallTarget | null {
    if (token.kind !== "function") return null;
    const targets = callTargets();

    const direct = targets.get(token.text);
    if (direct !== undefined) return direct;

    const dot = token.text.lastIndexOf(".");
    if (dot === -1) return null;
    const receiver = token.text.slice(0, dot);
    const bare = targets.get(receiver);
    return bare?.kind === "class" ? bare : null;
  }

  const cache = new Map<string, Document>();
  let requestToken = 0;
  let slowTimer: number | undefined;

  function remember(key: string, value: Document): void {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }

  /** The class as it is right now, which may be a class that has not been read yet. */
  function currentClass() {
    return classFor(props.tab.kind === "class" ? props.tab.subject : null);
  }

  createEffect(
    () => ({
      subject: props.tab.subject,
      unitId: props.tab.unitId,
      tab: props.tab.key,
      mode: mode(),
      revision: props.revision,
    }),
    (target) => {
      const token = (requestToken += 1);
      setDocument({ language: "c", preamble: [], epilogue: [], members: [] });
      setFailed(null);
      setPending(false);

      const timer = window.setTimeout(() => setPending(true), PENDING_DELAY_MS);
      slowTimer = window.setTimeout(() => props.onSlowOperation(true), SLOW_OPERATION_MS);

      const finish = () => {
        window.clearTimeout(timer);
        window.clearTimeout(slowTimer);
        props.onSlowOperation(false);
        setPending(false);
      };

      void (async () => {
        try {
          /*
           * A Java class is one document, and which methods it holds is a fact
           * about that document. The first open therefore reads the class, and
           * the member list is there afterwards — which is also what fills the
           * method rows in the column.
           */
          const before = currentClass();
          if (before !== null && before.members.length === 0) {
            await props.analysis.prepareClass(before.id);
            if (token !== requestToken) return;
          }

          const after = currentClass();
          const ids = after?.members ?? (target.subject === null ? [] : [target.subject]);
          if (ids.length === 0) {
            finish();
            setDocument({ language: "c", preamble: [], epilogue: [], members: [] });
            return;
          }

          // The member list is part of the key: the same tab renders the class
          // document before its members are known and the split document after,
          // and the cached one must not stand in for the other.
          const key = `${target.unitId}:${target.subject}:${target.mode}:${ids.join(",")}`;
          const cached = cache.get(key);
          if (cached) {
            finish();
            setDocument(cached);
            return;
          }

          const loaded: Member[] = new Array(ids.length);
          const languages = new Set<CodeLanguage>();
          // One map for the whole load: `functions()` builds a fresh array, and
          // asking it once per member would be a scan per member.
          const functionsById = new Map(props.analysis.functions().map((entry) => [entry.id, entry]));
          let cursor = 0;
          const worker = async (): Promise<void> => {
            while (cursor < ids.length) {
              const index = cursor;
              cursor += 1;
              const id = ids[index];
              if (id === undefined) continue;
              const meta = functionsById.get(id);
              const result: FunctionCode | { lines: readonly DisassemblyLine[] } =
                target.mode === "asm"
                  ? await props.analysis.disassemble(id)
                  : await props.analysis.decompile(id);
              const language: CodeLanguage =
                "language" in result ? result.language : "c";
              languages.add(language);
              loaded[index] = {
                id,
                name: meta?.name ?? id,
                // A Java member has no address and no byte size; the signature on
                // the line below is the only description it needs.
                detail:
                  meta === undefined || language === "java"
                    ? ""
                    : `0x${meta.address.toString(16).padStart(8, "0")} · ${meta.size} bytes`,
                lines: result.lines,
              };
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, () => worker()),
          );

          if (token !== requestToken) return;
          const value: Document = {
            language: languages.values().next().value ?? "c",
            preamble: after?.preamble ?? [],
            epilogue: after?.epilogue ?? [],
            members: loaded,
          };
          remember(key, value);
          finish();
          setDocument(value);
        } catch (error) {
          if (token !== requestToken) return;
          finish();
          setFailed(error instanceof Error ? error.message : String(error));
        }
      })();

      return () => {
        window.clearTimeout(timer);
        window.clearTimeout(slowTimer);
        props.onSlowOperation(false);
        if (token === requestToken) requestToken += 1;
      };
    },
  );

  onCleanup(() => {
    requestToken += 1;
    window.clearTimeout(slowTimer);
  });

  /** One block of lines. The member header is drawn by the caller, not here. */
  function Lines(props_: {
    readonly lines: readonly (CodeLine | DisassemblyLine)[];
    readonly language: CodeLanguage;
  }) {
    return (
      <div class="code-block">
        <For each={props_.lines}>
          {(line, lineIndex) => (
            <div class="code-line" data-line={lineIndex() + 1}>
              <span class="line-no">{lineIndex() + 1}</span>
              {/*
                The address column exists only when there is an address.
                Decompiled code is reconstructed source, not instructions, so it
                has none — and an empty 10ch column between the number and the
                code is a wide gap that looks like a mistake, because it is one.
              */}
              <Show when={line.address > 0}>
                <span class="line-addr">{formatAddress(line.address)}</span>
              </Show>
              <Show when={hasBytes(line) ? line : null}>
                {(instruction) => <span class="line-bytes">{instruction().bytes}</span>}
              </Show>
              <span class="code">
                <For
                  each={
                    mode() === "asm"
                      ? highlightAsm((line as DisassemblyLine).text)
                      : props_.language === "java"
                        ? highlightJava((line as CodeLine).text)
                        : highlightC((line as CodeLine).text)
                  }
                >
                  {(token: Token) => (
                    <Show when={targetFor(token)} fallback={<span class={`tok tok-${token.kind}`}>{token.text}</span>}>
                      {(target) => (
                        <button
                          class="tok tok-fn tok-jump"
                          type="button"
                          data-jump={target().id}
                          title={`Go to ${token.text}`}
                          onClick={() => {
                            if (target().kind === "class") props.onJumpToClass(target().id);
                            else props.onJumpToFunction(target().id);
                          }}
                        >
                          {token.text}
                        </button>
                      )}
                    </Show>
                  )}
                </For>
              </span>
            </div>
          )}
        </For>
      </div>
    );
  }

  return (
    <div class="view-code" data-testid="code-view" data-mode={mode()} data-language={document().language}>
      <div class="code-body" data-testid="code-body">
        <Show
          when={document().members.length > 0 || document().preamble.length > 0}
          fallback={
            <Show
              when={failed()}
              fallback={
                <Show
                  when={pending()}
                  fallback={
                    <div class="workspace-empty" data-testid="code-empty">
                      <Show when={props.busy}>
                        <div class="empty-field" aria-hidden="true">
                          <StructureField />
                        </div>
                      </Show>
                      <p class="workspace-empty-label">Nothing to show</p>
                      <p class="workspace-empty-hint">
                        This class has no members, or its body is still being read.
                      </p>
                    </div>
                  }
                >
                  <div class="code-pending" data-testid="code-pending">
                    <p class="code-pending-label">
                      {mode() === "asm" ? "DISASSEMBLING" : "DECOMPILING"}
                    </p>
                  </div>
                </Show>
              }
            >
              {(message) => <p class="code-failed">{message()}</p>}
            </Show>
          }
        >
          <div class="code-scroll">
            {/* The class's own part: the package, the imports, the fields. No
                member owns these lines, so no member header introduces them. */}
            <Show when={document().preamble.length > 0}>
              <div data-part="preamble">
                <Lines lines={document().preamble} language={document().language} />
              </div>
            </Show>

            <For each={document().members}>
              {(member, memberIndex) => {
                const marked = () => props.tab.mark === member.id;
                return (
                  <>
                    <Show when={props.tab.kind === "class"}>
                      <div class="code-member" data-member={member.name} data-id={member.id} data-hit={marked() ? "true" : "false"}>
                        <span class="code-member-name">{member.name}</span>
                        <span class="code-member-detail">{member.detail}</span>
                      </div>
                    </Show>
                    <div class="code-block" data-hit={marked() ? "true" : "false"}>
                      <Lines lines={member.lines} language={document().language} />
                    </div>
                    <Show when={memberIndex() < document().members.length - 1}>
                      <div class="code-member-gap" />
                    </Show>
                  </>
                );
              }}
            </For>

            <Show when={document().epilogue.length > 0}>
              <div data-part="epilogue">
                <Lines lines={document().epilogue} language={document().language} />
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
