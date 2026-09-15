import {
  Agent,
  convertToLlm,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  Type,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Conversation } from "../../features/chat/types";
import { loadPiProvider } from "../../features/models/pi-providers";
import { modelKey, type ModelProvider } from "../../features/models/types";
import { artifactAvailable, artifactUrl } from "../analysis/engine-artifacts";
import { ARCHIVE_PATH } from "../analysis/rasc/wasi";
import { ENGINE_WASM } from "./sandbox";
import { detectFormat, type FormatMatch } from "../detect-format";
import { openSandbox, type SandboxSession } from "./sandbox";
import type { Usage } from "@earendil-works/pi-ai";
import type { SandboxOutcome } from "./quickjs-sandbox";
import { customModel, resolveThinkingLevel } from "../../features/models/model-facts";
import { deviceParagraph, deviceTools } from "./device-tools";
import { fileTools } from "./file-tools";
import {
  COMPACTION,
  needsCompaction,
  planCompaction,
  summarize,
  summaryMessage,
  type CompactionOutcome,
} from "./compaction";
import type { DeviceBridge } from "./device-bridge";

const SYSTEM_PROMPT = `You are Repi, a reverse-engineering agent running in a browser.

You inspect the user's attached binary by writing short JavaScript programs with run_js. The
program runs on the user's device, beside the analyser, and only what it prints or returns
comes back to you — the binary never leaves the machine and never enters this conversation.

You have a filesystem, and it keeps things. \`write\` stores text under a path — a script you
are about to run twice, a listing you computed, a note worth keeping — and \`read\` opens one
line by line, \`edit\` changes one exact string. Files live where the user's storage panel and
their \`@\` menu look, so what you save is something they can see and hand back to you later, and
what they save is something you can open.

Write a program when you want to know something. The analyser's own output is large (a class
list from a real APK is around 20 MB, and a string table is bigger), so filter with the
engine's flags first (--filter, --limit, --offset), compute in the program, and return a
small answer: a count, a few rows, a summary. A program that returns a whole table is a
program that told you nothing.

An APK has two layers and you can look at both in one program: rasc reads the DEX side (its
class list, its strings, its manifest, a decompiled class), extract() pulls a native library
out of the archive, and Kuna reads that library. Ask for whichever you need — nothing has to
be decided up front.

Never claim to have inspected bytes, functions, strings or code that no tool returned. When
an analyser is not installed for a file, say so. Be concise, cite class and function names
where they are useful, and prefer one program that answers the question over many that
print raw output.`;

export interface AgentRunCallbacks {
  readonly onText: (text: string) => void;
  readonly onActivity: (activity: string | undefined) => void;
  /**
   * What the last exchange cost, once it is known.
   *
   * Reported per assistant message rather than once at the end, because a turn is many requests
   * when tools are involved and the interesting number is the one that keeps growing:
   * the conversation is not full after the last turn, it is full after the fourth tool call.
   */
  readonly onUsage?: (usage: Usage) => void;
  /**
   * Older messages were summarized to make room.
   *
   * The page is told because the transcript it shows and stores is its business: the summary is
   * part of the messages that come back, but "the first forty messages are gone" is a fact the
   * user should be able to see rather than infer from a gap.
   */
  readonly onCompacted?: (outcome: CompactionOutcome) => void;
}

/** A file the user pointed at with `@`, resolved before the run starts. */
export interface AgentReference {
  readonly id: string;
  readonly name: string;
  readonly kind: "attachment" | "derived";
  readonly bytes: number;
  readonly sandboxPath?: string;
  readonly fileId?: string;
}

export interface AgentRunResult {
  /** The transcript to keep: pi's messages, including a summary if one was made. */
  readonly messages: readonly AgentMessage[];
  readonly text: string;
  readonly error: string | null;
}

/** How small a file cannot be a real engine wasm. */
const MIN_ENGINE_BYTES = 500_000;

export interface RepiAgentRuntimeOptions {
  readonly openFile: (id: string) => Promise<File>;
  /**
   * The shared virtual filesystem: what earlier sessions produced, and where a program's
   * output goes. The agent does not know what a store is — it hands bytes over and asks for
   * what is there — which is what keeps the sandbox testable without a browser.
   */
  readonly vfs: {
    list(): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]>;
    save(path: string, bytes: Uint8Array, conversationId: string): Promise<void>;
    /**
     * One file, by metadata and by bytes.
     *
     * `list` loads everything, which is what the sandbox mount needs and what a tool must never
     * do: reading one file should cost that file, not the whole filesystem beside it.
     */
    stat(path: string): Promise<number | null>;
    read(path: string): Promise<Uint8Array | null>;
  };
  /**
   * The Android device, when one is attached. Absent in a build without WebUSB.
   *
   * A device is the one input that is not a file: it is a live, user-authorized, revocable
   * link to a phone, and its commands are asynchronous, so it is a tool surface of its own
   * rather than a function inside the sandbox.
   */
  readonly device?: DeviceBridge;
}

function selectedProvider(
  providers: readonly ModelProvider[],
  selectedKey: string,
): { readonly provider: ModelProvider; readonly modelId: string } | null {
  for (const provider of providers) {
    const modelId = provider.models.find((candidate) => modelKey(provider.id, candidate) === selectedKey);
    if (modelId) return { provider, modelId };
  }
  return null;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function seedMessages(conversation: Conversation): AgentMessage[] {
  if (conversation.agentMessages) return [...conversation.agentMessages];

  return conversation.lines.flatMap((line): AgentMessage[] => {
    if (line.kind === "you") {
      return [{ role: "user", content: line.text, timestamp: conversation.updatedAt }];
    }
    return [];
  });
}

/** A tool result is text; this is the one place that turns a value into it, bounded. */
function toolText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const limit = 80_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[tool result truncated]`;
}

interface Loaded {
  readonly file: File;
  readonly format: FormatMatch;
  readonly sandbox: SandboxSession;
}

/** What the model is told before it writes its first program. */
const RUN_JS_DESCRIPTION = `Run a short JavaScript program against the attached binary, locally.

These are the tools, and you may call any of them: **rasc** (APK/DEX), **Kuna** (native
binaries), **extract** (one entry out of an archive), **tools** (what is loaded). One may
have to be fetched before it can run; when that happens the host loads it and runs your
program again, so read the answer, not a first failure. In scope:

  rasc(args)     runs the engine and returns { stdout, stderr, code }. args is its command
                 line — the attached archive is mounted at "${ARCHIVE_PATH}". Kuna takes its
                 commands as a function that reads files already mounted. Examples:
                   rasc(['manifest', "${ARCHIVE_PATH}"])
                   rasc(['classes', '--filter', 'Activity', "${ARCHIVE_PATH}"])
                   rasc(['strings', '--limit', '50', '--filter', 'http', "${ARCHIVE_PATH}"])
                   rasc(['getclass', "${ARCHIVE_PATH}", 'com.example.MainActivity'])
                   extract('/lib/arm64-v8a/libfoo.so')      // { path, bytes }
                   kuna([binaryPath, 'list'])               // functions, with addresses
                   kuna([binaryPath, 'decompile', 'JNI_OnLoad'])
  extract(path)  pulls one entry out of the archive and mounts it, returning the path to use
                 afterwards — this is how a native library inside an APK reaches Kuna.
  tools()        what this sandbox can do: each tool, and whether it is loaded yet.
  print(value)   adds a line to what you receive. The last expression's value (or a returned
                 value) is returned to you as well.

There is no network, no filesystem and no import: nothing else is reachable.

Filter in the engine, not after it. Its output is tens of megabytes on a real APK, one call
re-walks the archive in a few hundred milliseconds, and everything you print comes back to
you. Prefer a few well-argued calls over many, and return counts and samples rather than
tables. A long-running program is interrupted and a memory-heavy one fails with an error you
can read and fix. Kuna fetches the SLEIGH spec for a binary's architecture on demand: a
program that needs one is run again for you, so read the engine's answer, not a first
failure.`;

/** Renders one program's outcome as the text the model reads. */
function renderOutcome(entry: Loaded, outcome: SandboxOutcome): string {
  const parts: string[] = [];
  if (outcome.result !== null && outcome.result.length > 0) parts.push(`result:
${outcome.result}`);
  if (outcome.printed.length > 0) parts.push(`printed:
${outcome.printed}`);
  if (outcome.error) {
    const where = outcome.error.stack ? `
${outcome.error.stack.split("\n").slice(0, 3).join("\n")}` : "";
    parts.push(`error: ${outcome.error.name}: ${outcome.error.message}${where}`);
  }
  parts.push(
    `[${entry.format.label}: ${outcome.calls} engine call(s), ${outcome.ms} ms` +
      `${outcome.truncated ? ", output truncated" : ""}]`,
  );
  return parts.join("\n\n");
}

/**
 * Browser-hosted Pi agent runtime.
 *
 * Pi owns the model/tool loop. This adapter owns the sandbox the model writes programs into
 * and keeps `File` objects behind the local seam; only the text a program prints or returns
 * can reach the provider.
 */
export function createRepiAgentRuntime(options: RepiAgentRuntimeOptions) {
  const loaded = new Map<string, Promise<Loaded>>();
  let activeAgent: Agent | null = null;

  const fileLine = (conversation: Conversation, fileId: string) =>
    conversation.lines.find((line) => line.kind === "file" && line.storedFileId === fileId);

  /**
   * Opens the engine for one attached binary, once per conversation.
   *
   * The sandbox is bound to one archive for its life, which is what makes `rasc(args)` a
   * function call rather than a protocol: the program names the mount, and the bytes are
   * already there.
   */
  /** Files written on every loaded session's behalf, so their mounts can be refreshed. */
  const pendingSaves: Promise<unknown>[] = [];

  /**
   * Hands files to every session that has the filesystem mounted.
   *
   * A session's mount is a snapshot, and the page can write files behind its back — with a tool,
   * or through another session. The writer's own copy is already in its map (a program's writes
   * land there as they happen), and sending it again costs one message and keeps this honest
   * about who needs to know: everyone the file changed for, which is everyone.
   */
  const pushFiles = (files: readonly { readonly path: string; readonly bytes: Uint8Array }[]) => {
    if (files.length === 0) return;
    for (const entry of loaded.values()) {
      void entry
        .then((session) => session.sandbox.refreshVfs(files))
        .catch(() => undefined);
    }
  };

  const load = (conversation: Conversation, fileId: string): Promise<Loaded> => {
    const known = loaded.get(fileId);
    if (known) return known;

    const task = (async () => {
      const line = fileLine(conversation, fileId);
      if (!line || line.kind !== "file") throw new Error("That binary is not attached to this conversation.");
      const file = await options.openFile(fileId);
      const format = await detectFormat(file);

      /*
       * What the sandbox can do is what this deployment has installed, not what the file's
       * format implies. An APK is rasc plus Kuna the moment a program extracts a native
       * library from it, and a deployment that built only one engine still gives the other
       * name an answer ("not installed in this build") instead of refusing the file.
       */
      const installed: ("rasc" | "kuna")[] = [];
      for (const name of ["rasc", "kuna"] as const) {
        if (await artifactAvailable(ENGINE_WASM[name], MIN_ENGINE_BYTES)) installed.push(name);
      }
      const warm = format.engine !== null && installed.includes(format.engine) ? format.engine : undefined;
      if (installed.length === 0) {
        throw new Error(
          `No analyser is installed in this build, so ${format.label} cannot be analysed. ` +
            "Run `npm run build:rasc` or `npm run build:kuna`, then reload.",
        );
      }
      const vfs = await options.vfs.list().catch(() => []);
      return {
        file,
        format,
        sandbox: openSandbox(file, {
          ...(vfs.length > 0 ? { vfs } : {}),
          // A program's output is persisted where every conversation can see it: the point of
          // the sandbox having a filesystem rather than a scratch copy of one.
          onProduced: (files) => {
            for (const produced of files) {
              pendingSaves.push(
                options.vfs.save(produced.path, produced.bytes, conversation.id).catch(() => undefined),
              );
            }
            // The same path can be read from another attached binary's sandbox, so the file
            // goes to every open mount rather than only the one that produced it.
            pushFiles(files);
          },
          engines: installed,
          ...(warm ? { warm } : {}),
          ...(installed.includes("kuna")
            ? {
                specRoot: artifactUrl("kuna", "specs"),
                smallBundleUrl: artifactUrl("kuna", "specs-small.json"),
              }
            : {}),
        }),
      };
    })();
    loaded.set(fileId, task);
    task.catch(() => loaded.delete(fileId));
    return task;
  };

  const toolsFor = (conversation: Conversation): AgentTool[] => [
    ...deviceTools(options, conversation.id),
    ...fileTools(
      {
        files: {
          stat: (path) => options.vfs.stat(path),
          read: (path) => options.vfs.read(path),
          write: async (path, bytes, id) => {
            await options.vfs.save(path, bytes, id);
            // Written where the panel and other conversations can see it, and mounted where a
            // program can open it.
            pushFiles([{ path, bytes }]);
          },
        },
      },
      conversation.id,
    ),
    {
      name: "list_binaries",
      label: "List binaries",
      description: "List binaries attached to this conversation and their local file IDs.",
      parameters: Type.Object({}),
      async execute() {
        const files = conversation.lines
          .filter((line) => line.kind === "file")
          .map((line) => ({
            fileId: line.storedFileId ?? null,
            name: line.name,
            size: line.size,
            format: line.format,
            architecture: line.detail,
            analyser: line.engine,
            availableToTools: line.storedFileId !== undefined,
          }));
        return {
          content: [{ type: "text", text: toolText({ files }) }],
          details: { count: files.length },
        };
      },
    },
    {
      name: "run_js",
      label: "Run JavaScript",
      description: RUN_JS_DESCRIPTION,
      parameters: Type.Object({
        fileId: Type.String({ description: "Local file ID from list_binaries" }),
        code: Type.String({ description: "The JavaScript program to run in the sandbox" }),
      }),
      async execute(_toolCallId, input, signal) {
        const params = input as { fileId: string; code: string };
        const entry = await load(conversation, params.fileId);
        if (signal?.aborted) throw new Error("Stopped.");
        const outcome = await entry.sandbox.run(params.code);
        // The program's output becomes files; until they are stored, nothing else can read them.
        await Promise.all(pendingSaves.splice(0));
        return {
          content: [{ type: "text", text: toolText(renderOutcome(entry, outcome)) }],
          details: outcome,
        };
      },
    },
  ];

  /**
   * The conversation's model, its key, and how to stream from it.
   *
   * Shared with compaction because a summary is a request like any other: same provider, same
   * model, same key. Anything else would be a second opinion about which model this conversation
   * is having.
   */
  const resolveChoice = async (
    conversation: Conversation,
    providers: readonly ModelProvider[],
  ): Promise<{
    model: Model<Api>;
    apiKey: string;
    providerStream: (
      model: Model<Api>,
      context: Parameters<typeof streamSimple>[1],
      options: Parameters<typeof streamSimple>[2],
    ) => ReturnType<typeof streamSimple>;
  }> => {
    const selectedKey = conversation.selectedModelKey;
    if (!selectedKey) throw new Error("Choose a model before sending a message.");
    const choice = selectedProvider(providers, selectedKey);
    if (!choice) throw new Error("The selected model provider is no longer available.");

    let model: Model<Api>;
    let apiKey: string;
    let providerStream: (
      model: Model<Api>,
      context: Parameters<typeof streamSimple>[1],
      options: Parameters<typeof streamSimple>[2],
    ) => ReturnType<typeof streamSimple>;

    if (choice.provider.kind === "custom") {
      // The same model object the thinking menu was built from: one definition, so the levels
      // offered and the levels sent cannot drift apart.
      model = customModel(choice.provider, choice.modelId);
      apiKey = choice.provider.apiKey || "repi-local";
      providerStream = (activeModel, context, streamOptions) =>
        streamSimple(activeModel as Model<"openai-completions">, context, streamOptions);
    } else {
      const piProvider = await loadPiProvider(choice.provider.builtinId);
      const piModel = piProvider.getModels().find((candidate) => candidate.id === choice.modelId);
      if (!piModel) throw new Error("The selected model is no longer in Pi's provider catalog.");

      const baseUrl = choice.provider.baseUrl || piModel.baseUrl;
      apiKey = choice.provider.apiKey;
      model = { ...piModel, baseUrl };
      providerStream = (activeModel, context, streamOptions) =>
        piProvider.streamSimple(activeModel, context, streamOptions);
    }

    return { model, apiKey, providerStream };
  };

  /** One request, completing rather than streaming: what a summary needs. */
  const completeOnce = (
    providerStream: (model: Model<Api>, context: Parameters<typeof streamSimple>[1], options: Parameters<typeof streamSimple>[2]) => ReturnType<typeof streamSimple>,
  ) => async (model: Model<string>, context: Parameters<typeof streamSimple>[1], options?: Parameters<typeof streamSimple>[2]) =>
    providerStream(model as Model<Api>, context, { ...options, timeoutMs: 120_000 }).result();

  /**
   * Summarizes the older part of a transcript, if there is a plan for it.
   *
   * Returns null when there is nothing to do — a short conversation, or one that is already one
   * turn — so callers can run it unconditionally where the threshold is not the question.
   */
  const compactMessages = async (
    messages: readonly AgentMessage[],
    options: {
      readonly model: Model<Api>;
      readonly providerStream: (model: Model<Api>, context: Parameters<typeof streamSimple>[1], options: Parameters<typeof streamSimple>[2]) => ReturnType<typeof streamSimple>;
      readonly thinkingLevel: ReturnType<typeof resolveThinkingLevel>;
      readonly instructions?: string;
    },
  ): Promise<{ messages: AgentMessage[]; outcome: CompactionOutcome } | null> => {
    const plan = planCompaction(messages, COMPACTION);
    if (plan === null) return null;
    const outcome = await summarize(plan, {
      model: options.model,
      ...(options.thinkingLevel === "off" ? {} : { thinkingLevel: options.thinkingLevel }),
      ...(options.instructions ? { instructions: options.instructions } : {}),
      complete: completeOnce(options.providerStream),
    });
    return {
      messages: [summaryMessage(outcome.summary, outcome.tokensBefore), ...outcome.keep],
      outcome,
    };
  };

  const run = async (
    conversation: Conversation,
    providers: readonly ModelProvider[],
    text: string,
    callbacks: AgentRunCallbacks,
    references: readonly AgentReference[] = [],
  ): Promise<AgentRunResult> => {
    const { model, apiKey, providerStream } = await resolveChoice(conversation, providers);
    // What the conversation asked for, folded into what this model accepts: a model that cannot
    // think runs at "off" instead of failing, and one that names its levels differently gets
    // its own name for the one that was asked for.
    const thinkingLevel = resolveThinkingLevel(model, conversation.thinkingLevel);

    /*
     * Compact before the first request when the transcript is already over the threshold. The
     * check is on the transcript rather than on the last report, because the last report is from
     * the previous turn: by the time a request fails for being too long, it is already too late
     * to fix it in that turn.
     */
    let seed = seedMessages(conversation);
    if (needsCompaction(seed, model.contextWindow)) {
      const compacted = await compactMessages(seed, { model, providerStream, thinkingLevel });
      if (compacted) {
        seed = compacted.messages;
        callbacks.onCompacted?.(compacted.outcome);
      }
    }

    let completedText = "";
    let currentText = "";
    let finalError: string | null = null;
    let turns = 0;
    /** Set when a turn ended because the context filled: the run continues after compacting. */
    let compacting = false;
    const visibleText = () => [completedText, currentText].filter(Boolean).join("\n\n");
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT + deviceParagraph(options.device?.describe() ?? null),
        model,
        thinkingLevel,
        tools: toolsFor(conversation),
        messages: seed,
      },
      streamFn: (activeModel, context, streamOptions) =>
        providerStream(activeModel, context, {
          ...streamOptions,
          timeoutMs: 120_000,
          maxRetries: 1,
        }),
      // pi's own converter, so a `compactionSummary` message in the transcript reaches the
      // provider as the `<summary>` block pi builds, rather than as a role nobody sends.
      convertToLlm,
      getApiKey: () => apiKey,
      shouldStopAfterTurn: () => {
        turns += 1;
        if (turns >= 12) return true;
        // Stop *before* the next request rather than after it fails: the context is over its
        // threshold, and the run resumes with the compacted transcript a moment later.
        if (needsCompaction(agent.state.messages, model.contextWindow)) {
          compacting = true;
          return true;
        }
        return false;
      },
      sessionId: conversation.id,
    });
    activeAgent = agent;

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        currentText = "";
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        currentText += event.assistantMessageEvent.delta;
        callbacks.onText(visibleText());
        callbacks.onActivity(undefined);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
        // Thinking is invisible in the transcript, so the one thing the user needs to know is
        // that the wait is work rather than a stall.
        callbacks.onActivity("Thinking…");
      } else if (event.type === "tool_execution_start") {
        callbacks.onActivity(`Using ${event.toolName.replaceAll("_", " ")}…`);
      } else if (event.type === "tool_execution_end") {
        callbacks.onActivity(undefined);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.usage) callbacks.onUsage?.(event.message.usage);
        const complete = assistantText(event.message);
        if (complete) {
          currentText = complete;
          callbacks.onText(visibleText());
          completedText = visibleText();
          currentText = "";
        }
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
          finalError =
            event.message.stopReason === "aborted"
              ? "Stopped."
              : (event.message.errorMessage ?? "The model request failed.");
        }
      }
    });

    try {
      /*
       * A mention is a name; the model needs a place. The user's sentence is sent as written, and
       * the files it points at follow it, described in the same terms the sandbox and `run_js`
       * use — a path a program can open, or the id a binary is loaded under. Without this the
       * `@` is decoration the model can only guess about.
       */
      const described = references.map((reference) =>
        reference.kind === "attachment"
          ? `- ${reference.name} — the attached binary, ${reference.bytes} bytes${
              reference.fileId ? `, fileId ${reference.fileId} for run_js` : ""
            }`
          : `- ${reference.id} — ${reference.bytes} bytes, in the sandbox at ${
              reference.sandboxPath ?? reference.id
            }`,
      );
      await agent.prompt(
        described.length === 0
          ? text
          : `${text}\n\n[the user pointed at ${described.length === 1 ? "this file" : "these files"}]\n${described.join("\n")}`,
      );

      /*
       * A turn that ended because the context filled resumes here.
       *
       * The transcript is rewritten in the agent's own state — the summary at its head, the recent
       * messages after it — and `continue()` takes a fresh snapshot of exactly that, which is what
       * makes this a continuation rather than a second question. Bounded, because a summary
       * that does not free enough room would otherwise loop: three rounds in, the run stops and
       * the error is the honest outcome.
       */
      for (let round = 0; compacting && round < 3; round += 1) {
        compacting = false;
        const compacted = await compactMessages(agent.state.messages, {
          model,
          providerStream,
          thinkingLevel,
        });
        if (!compacted) break;
        agent.state.messages = [...compacted.messages];
        callbacks.onCompacted?.(compacted.outcome);
        turns = 0;
        await agent.continue();
      }

      return {
        messages: agent.state.messages.filter(
          (message): message is AgentMessage =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult" ||
            // The summary is part of what is kept: it is the head of the transcript the next run
            // starts from, and dropping it here would silently forget the compacted history.
            message.role === "compactionSummary",
        ),
        text: visibleText(),
        error: finalError,
      };
    } finally {
      unsubscribe();
      if (activeAgent === agent) activeAgent = null;
    }
  };

  /**
   * Summarizes this conversation now, without asking anything.
   *
   * The same work the automatic path does, on demand: a person who can see the meter filling up
   * should not have to wait for the wall to hit it. Returns the messages to store — the summary
   * and the tail that was kept — or null when there is nothing worth summarizing.
   */
  const compact = async (
    conversation: Conversation,
    providers: readonly ModelProvider[],
    instructions?: string,
  ): Promise<{ messages: AgentMessage[]; outcome: CompactionOutcome } | null> => {
    const { model, providerStream } = await resolveChoice(conversation, providers);
    return compactMessages(seedMessages(conversation), {
      model,
      providerStream,
      thinkingLevel: resolveThinkingLevel(model, conversation.thinkingLevel),
      ...(instructions ? { instructions } : {}),
    });
  };

  const abort = () => activeAgent?.abort();
  const disposeConversation = (conversation: Conversation) => {
    for (const line of conversation.lines) {
      if (line.kind !== "file" || !line.storedFileId) continue;
      void loaded.get(line.storedFileId)?.then((entry) => entry.sandbox.close());
      loaded.delete(line.storedFileId);
    }
  };

  return { run, compact, abort, disposeConversation };
}
