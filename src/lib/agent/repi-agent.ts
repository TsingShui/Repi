import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Conversation } from "../../features/chat/types";
import { loadPiProvider } from "../../features/models/pi-providers";
import { modelKey, type ModelProvider } from "../../features/models/types";
import { chooseSource } from "../analysis/choose-source";
import type { AnalysisSource, UnitAnalysis } from "../analysis/types";
import { formatAddress } from "../analysis/types";
import { detectFormat } from "../detect-format";

const SYSTEM_PROMPT = `You are Repi, a reverse-engineering agent running in a browser.
Use the provided read-only tools to inspect the user's attached binaries before making claims about them.
The binary itself stays on the user's device. Tool results contain only bounded text selected from local analysis.
Never claim that you inspected bytes, functions, strings, or code unless a tool returned that information.
Be concise, cite function names and addresses when useful, and say clearly when an analyser is unavailable.`;

export interface AgentRunCallbacks {
  readonly onText: (text: string) => void;
  readonly onActivity: (activity: string | undefined) => void;
}

export interface AgentRunResult {
  readonly messages: readonly Message[];
  readonly text: string;
  readonly error: string | null;
}

interface AnalysedFile {
  readonly file: File;
  readonly source: AnalysisSource;
  readonly scanned: Set<string>;
}

export interface RepiAgentRuntimeOptions {
  readonly openFile: (id: string) => Promise<File>;
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

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function toolText(value: unknown): string {
  const text = JSON.stringify(value);
  const limit = 80_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[tool result truncated]`;
}

/**
 * Browser-hosted Pi agent runtime.
 *
 * Pi owns the model/tool loop. This adapter owns the browser-specific tools and
 * keeps File/Blob objects behind the local analysis seam; only bounded text tool
 * results can reach the provider.
 */
export function createRepiAgentRuntime(options: RepiAgentRuntimeOptions) {
  const analysed = new Map<string, Promise<AnalysedFile>>();
  let activeAgent: Agent | null = null;

  const fileLine = (conversation: Conversation, fileId: string) =>
    conversation.lines.find(
      (line) => line.kind === "file" && line.storedFileId === fileId,
    );

  const stopAnalysis = (entry: AnalysedFile) => entry.source.stop();

  const load = async (conversation: Conversation, fileId: string): Promise<AnalysedFile> => {
    const known = analysed.get(fileId);
    if (known) return known;

    const task = (async () => {
      const line = fileLine(conversation, fileId);
      if (!line || line.kind !== "file") throw new Error("That binary is not attached to this conversation.");
      if (line.engine === null) throw new Error(`No local analyser supports ${line.format}.`);

      const file = await options.openFile(fileId);
      const format = await detectFormat(file);
      const chosen = await chooseSource(file, format);
      if (!chosen.source) throw new Error(chosen.unavailable ?? "No local analyser is available for this file.");
      return { file, source: chosen.source, scanned: new Set<string>() };
    })();
    analysed.set(fileId, task);
    task.catch(() => analysed.delete(fileId));
    return task;
  };

  const unit = async (
    conversation: Conversation,
    fileId: string,
    unitId?: string,
    signal?: AbortSignal,
  ): Promise<UnitAnalysis> => {
    const entry = await load(conversation, fileId);
    const id = unitId ?? entry.source.primaryUnitId;
    const analysis = entry.source.unit(id);
    if (!entry.scanned.has(id)) {
      const stop = () => stopAnalysis(entry);
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const outcome = await analysis.scan(() => undefined);
        if (outcome !== "ready") throw new Error(`Analysis ended with status: ${outcome}.`);
        entry.scanned.add(id);
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    }
    return analysis;
  };

  const toolsFor = (conversation: Conversation): AgentTool[] => [
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
      name: "inspect_binary",
      label: "Inspect binary",
      description:
        "Run the local analyser and return bounded metadata plus samples of functions, classes, sections, imports and exports.",
      parameters: Type.Object({
        fileId: Type.String({ description: "Local file ID from list_binaries" }),
        unitId: Type.Optional(Type.String({ description: "Unit ID; omit for the primary unit" })),
      }),
      async execute(_toolCallId, input, signal) {
        const params = input as { fileId: string; unitId?: string };
        const entry = await load(conversation, params.fileId);
        const target = await unit(conversation, params.fileId, params.unitId, signal);
        const limit = 40;
        const facts = target.facts();
        const result = {
          file: entry.file.name,
          units: entry.source.units,
          activeUnit: target.unit,
          capabilities: target.capabilities,
          facts,
          functionCount: target.functions().length,
          functions: target.functions().slice(0, limit).map((fn) => ({
            id: fn.id,
            name: fn.name,
            address: formatAddress(fn.address),
            size: fn.size,
          })),
          classCount: target.classes().length,
          classes: target.classes().slice(0, limit).map((item) => ({
            id: item.id,
            name: item.qualifiedName,
          })),
          stringCount: target.stringTotal?.() ?? target.strings().length,
          sections: target.sections().slice(0, limit),
          imports: target.imports().slice(0, limit),
          exports: target.exports().slice(0, limit),
          truncated:
            target.functions().length > limit ||
            target.classes().length > limit ||
            target.sections().length > limit ||
            target.imports().length > limit ||
            target.exports().length > limit,
        };
        return { content: [{ type: "text", text: toolText(result) }], details: result };
      },
    },
    {
      name: "find_symbols",
      label: "Find symbols",
      description: "Find locally analysed functions or classes by a case-insensitive name fragment.",
      parameters: Type.Object({
        fileId: Type.String({ description: "Local file ID from list_binaries" }),
        query: Type.String({ description: "Name fragment" }),
        unitId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      }),
      async execute(_toolCallId, input, signal) {
        const params = input as { fileId: string; query: string; unitId?: string; limit?: number };
        const target = await unit(conversation, params.fileId, params.unitId, signal);
        const query = params.query.toLocaleLowerCase();
        const limit = boundedLimit(params.limit, 30, 100);
        const functions = target.functions()
          .filter((fn) => fn.name.toLocaleLowerCase().includes(query))
          .slice(0, limit)
          .map((fn) => ({ id: fn.id, name: fn.name, address: formatAddress(fn.address), size: fn.size }));
        const classes = target.classes()
          .filter((item) => item.qualifiedName.toLocaleLowerCase().includes(query))
          .slice(0, limit)
          .map((item) => ({ id: item.id, name: item.qualifiedName }));
        const result = { functions, classes };
        return { content: [{ type: "text", text: toolText(result) }], details: result };
      },
    },
    {
      name: "search_strings",
      label: "Search strings",
      description: "Search strings in a binary locally. Returns at most 100 matches.",
      parameters: Type.Object({
        fileId: Type.String({ description: "Local file ID from list_binaries" }),
        query: Type.String({ description: "Case-insensitive substring" }),
        unitId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      }),
      async execute(_toolCallId, input, signal) {
        const params = input as { fileId: string; query: string; unitId?: string; limit?: number };
        const target = await unit(conversation, params.fileId, params.unitId, signal);
        const limit = boundedLimit(params.limit, 30, 100);
        const results = target.searchStrings
          ? await target.searchStrings(params.query, limit)
          : target.strings()
              .filter((entry) => entry.value.toLocaleLowerCase().includes(params.query.toLocaleLowerCase()))
              .slice(0, limit);
        const output = results.map((entry) => ({
          id: entry.id,
          address: formatAddress(entry.address),
          value: entry.value,
          xrefs: entry.xrefs,
          functionId: entry.functionId,
        }));
        return { content: [{ type: "text", text: toolText({ strings: output }) }], details: output };
      },
    },
    {
      name: "decompile",
      label: "Decompile",
      description: "Decompile one function or class locally using an ID returned by another tool.",
      parameters: Type.Object({
        fileId: Type.String({ description: "Local file ID from list_binaries" }),
        functionId: Type.String({ description: "Function or class ID returned by inspect_binary/find_symbols" }),
        unitId: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, input, signal) {
        const params = input as { fileId: string; functionId: string; unitId?: string };
        const target = await unit(conversation, params.fileId, params.unitId, signal);
        const code = await target.decompile(params.functionId);
        const maxLines = 500;
        const text = code.lines
          .slice(0, maxLines)
          .map((line) => `${formatAddress(line.address)}  ${line.text}`)
          .join("\n");
        const result = {
          functionId: code.functionId,
          language: code.language,
          code: text,
          truncated: code.lines.length > maxLines,
        };
        return { content: [{ type: "text", text: toolText(result) }], details: result };
      },
    },
  ];

  const run = async (
    conversation: Conversation,
    providers: readonly ModelProvider[],
    text: string,
    callbacks: AgentRunCallbacks,
  ): Promise<AgentRunResult> => {
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
      model = {
        id: choice.modelId,
        name: choice.modelId,
        api: "openai-completions",
        provider: choice.provider.id,
        baseUrl: choice.provider.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      };
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

    let completedText = "";
    let currentText = "";
    let finalError: string | null = null;
    let turns = 0;
    const visibleText = () => [completedText, currentText].filter(Boolean).join("\n\n");
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        thinkingLevel: "off",
        tools: toolsFor(conversation),
        messages: seedMessages(conversation),
      },
      streamFn: (activeModel, context, streamOptions) =>
        providerStream(activeModel, context, {
          ...streamOptions,
          timeoutMs: 120_000,
          maxRetries: 1,
        }),
      getApiKey: () => apiKey,
      shouldStopAfterTurn: () => {
        turns += 1;
        return turns >= 12;
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
      } else if (event.type === "tool_execution_start") {
        callbacks.onActivity(`Using ${event.toolName.replaceAll("_", " ")}…`);
      } else if (event.type === "tool_execution_end") {
        callbacks.onActivity(undefined);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
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
      await agent.prompt(text);
      return {
        messages: agent.state.messages.filter(
          (message): message is Message =>
            message.role === "user" || message.role === "assistant" || message.role === "toolResult",
        ),
        text: visibleText(),
        error: finalError,
      };
    } finally {
      unsubscribe();
      if (activeAgent === agent) activeAgent = null;
    }
  };

  const abort = () => activeAgent?.abort();
  const disposeConversation = (conversation: Conversation) => {
    for (const line of conversation.lines) {
      if (line.kind !== "file" || !line.storedFileId) continue;
      void analysed.get(line.storedFileId)?.then(stopAnalysis);
      analysed.delete(line.storedFileId);
    }
  };

  return { run, abort, disposeConversation };
}
