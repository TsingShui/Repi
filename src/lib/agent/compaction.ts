/**
 * Compaction: what to do when the conversation no longer fits.
 *
 * The transcript is re-sent with every request, and an agent's transcript grows in jumps — one
 * engine listing is twenty thousand tokens — so the wall arrives in the middle of work rather
 * than at the end of it. Compaction summarizes the older part and keeps the recent part verbatim,
 * which is the only way to continue a conversation that has run out of room.
 *
 * The rules here are pi's, not this app's: the threshold (`contextWindow - reserveTokens`), the
 * recent budget (`keepRecentTokens`), the summary prompt, the format. What Repi contributes is the
 * one thing pi's harness cannot know — which provider to ask, because this app has a conversation
 * with a chosen model rather than a model registry — and the cut point, because pi's version walks
 * `Entry[]` (its session's records with ids) while Repi keeps plain messages.
 *
 * A summary is saved as pi saves it: its own `compactionSummary` message at the head of the
 * transcript, which pi's converter turns into a `<summary>` block on the way to the provider.
 * The transcript is therefore pi's message list rather than a shape of this app's, and the next
 * request is built by pi rather than by a convention invented here.
 */
import {
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  generateSummaryWithUsage,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type {
  AssistantMessage,
  Context as AiContext,
  Model,
  Models,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";

/**
 * pi's defaults, unchanged: a sixteenth of a 200K window held back for the answer, and the last
 * twenty thousand tokens kept verbatim.
 */
export const COMPACTION: CompactionSettings = DEFAULT_COMPACTION_SETTINGS;

/** What the conversation occupies, as pi estimates it: the last reported usage plus what came after. */
export function contextTokens(messages: readonly AgentMessage[]): number {
  return estimateContextTokens([...messages]).tokens;
}

/** Whether this conversation is at the point where the next request would not fit. */
export function needsCompaction(
  messages: readonly AgentMessage[],
  contextWindow: number,
  settings: CompactionSettings = COMPACTION,
): boolean {
  if (!(contextWindow > 0)) return false;
  return shouldCompact(contextTokens(messages), contextWindow, settings);
}

/**
 * The summary already in the transcript, if the conversation has been compacted before.
 *
 * Compacted twice, the second summary is an *update*: pi's prompt then asks for a revised
 * summary that folds in what happened since, which is why the previous one is worth finding
 * rather than starting from nothing and losing the early history.
 */
export function previousSummary(messages: readonly AgentMessage[]): string | undefined {
  const head = messages[0];
  if (head === undefined || head.role !== "compactionSummary") return undefined;
  const summary = (head as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim() !== "" ? summary : undefined;
}

/** The summary as pi stores it, which is also what `previousSummary` reads back. */
export function summaryMessage(summary: string, tokensBefore: number): AgentMessage {
  return createCompactionSummaryMessage(summary, tokensBefore, Date.now());
}

export interface CompactionPlan {
  /** The head: everything that goes into the summary. */
  readonly summarized: readonly AgentMessage[];
  /** The tail: kept as it is, so the work in progress survives. */
  readonly keep: readonly AgentMessage[];
  readonly tokensBefore: number;
}

/**
 * Where to cut the transcript.
 *
 * Walk back from the end until the recent budget is covered, then move the cut back to the
 * nearest user message. A cut anywhere else would take an assistant message apart from the tool
 * results that answer it, and a turn split in half is a transcript some providers refuse and all
 * of them misread — the cost of keeping a little more is paid in tokens, the cost of splitting is
 * paid in nonsense.
 *
 * Null when there is nothing worth doing: a transcript that is already one turn has no older part
 * to summarize, and a summary of everything leaves nothing to continue from.
 */
export function planCompaction(
  messages: readonly AgentMessage[],
  settings: CompactionSettings = COMPACTION,
): CompactionPlan | null {
  if (messages.length < 3) return null;

  let kept = 0;
  let cut = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (kept >= settings.keepRecentTokens) break;
    kept += estimateTokens(messages[index]!);
    cut = index;
  }
  // Back to a turn boundary: the tail must begin with what the user asked for.
  while (cut > 0 && messages[cut]?.role !== "user") cut -= 1;
  if (cut <= 0 || cut >= messages.length) return null;

  const summarized = messages.slice(0, cut);
  const keep = messages.slice(cut);
  if (summarized.length === 0 || keep.length === 0) return null;
  return { summarized, keep, tokensBefore: contextTokens(messages) };
}

export interface CompactionOutcome {
  readonly summary: string;
  readonly keep: readonly AgentMessage[];
  readonly tokensBefore: number;
  /** How many messages went into the summary. */
  readonly summarizedCount: number;
  readonly usage: Usage | undefined;
}

/**
 * A `Models` with one verb, because this app has one model per conversation rather than a registry.
 *
 * Only `completeSimple` is reachable from the summarization path — it is the single call in pi's
 * `completeSimpleWithRetries` — so the rest is absent on purpose rather than faked: if a future pi
 * asks this registry for something else, it should fail loudly here instead of quietly losing the
 * provider the user chose.
 */
function summaryRegistry(
  complete: (model: Model<string>, context: AiContext, options?: SimpleStreamOptions) => Promise<AssistantMessage>,
): Models {
  return { completeSimple: complete } as unknown as Models;
}

/**
 * Asks the same model to summarize the part being dropped.
 *
 * The summary is generated by the model the user chose, at the thinking level they chose, because
 * a summary of an analysis is itself an analysis: a cheaper model that misses what the work found
 * turns a compacted conversation into a forgotten one.
 */
export async function summarize(
  plan: CompactionPlan,
  options: {
    readonly model: Model<string>;
    readonly thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    readonly instructions?: string;
    readonly complete: (
      model: Model<string>,
      context: AiContext,
      options?: SimpleStreamOptions,
    ) => Promise<AssistantMessage>;
  },
): Promise<CompactionOutcome> {
  const before = previousSummary(plan.summarized);
  const result = await generateSummaryWithUsage(
    [...plan.summarized],
    summaryRegistry(options.complete),
    options.model,
    COMPACTION.reserveTokens,
    options.instructions,
    before,
    options.thinkingLevel,
    undefined,
    undefined,
    BACKGROUND_CONTEXT,
  );
  if (!result.ok) {
    throw new Error(`The conversation could not be summarized: ${result.error.message}`);
  }
  return {
    summary: result.value.text,
    keep: plan.keep,
    tokensBefore: plan.tokensBefore,
    summarizedCount: plan.summarized.length,
    usage: result.value.usage,
  };
}
