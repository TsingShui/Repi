/**
 * Compaction, checked where it can quietly ruin a conversation.
 *
 * Two failure modes are worth a check rather than a feel. The first is the cut: take an assistant
 * message away from the tool results that answer it and the next request is a transcript no model
 * can read, which shows up as a confusing provider error a long way from here. The second is
 * arithmetic — a summary that keeps too little forgets the work, and one that keeps too much pays
 * for the summary twice.
 *
 * pi owns the threshold and the summary prompt; what this app owns is the cut and the decision to
 * run it, and those are pure functions over a message list.
 *
 *   node ./scripts/run-analysis-check.mjs compaction-check
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  COMPACTION,
  contextTokens,
  needsCompaction,
  planCompaction,
  previousSummary,
  summaryMessage,
} from "../src/lib/agent/compaction";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

const user = (text: string): AgentMessage =>
  ({ role: "user", content: text, timestamp: 0 }) as AgentMessage;
const assistant = (text: string, tokens = 0): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 0,
    stopReason: "stop",
    usage: {
      input: tokens,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }) as AgentMessage;

/** An assistant message whose reported total is exactly `total`, for the boundary arithmetic. */
const assistantWithTotal = (total: number): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "x" }],
    timestamp: 0,
    stopReason: "stop",
    usage: {
      input: total,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: total,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }) as AgentMessage;
const toolResult = (text: string): AgentMessage =>
  ({ role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 }) as AgentMessage;

/** A conversation of `turns` exchanges, each with a tool result full of characters. */
const conversation = (turns: number, chars = 4_000): AgentMessage[] =>
  Array.from({ length: turns }, (_, index) => [
    user(`question ${index + 1}`),
    assistant(`answer ${index + 1}`),
    toolResult("x".repeat(chars)),
  ]).flat();

// 1. When a conversation is over its ceiling.
{
  check("an empty conversation needs nothing", !needsCompaction([], 128_000));
  check("a short one neither", !needsCompaction(conversation(2), 128_000));
  const full = [assistant("hi", 120_000)];
  check("a nearly full window does", needsCompaction(full, 128_000));
  check("a window of zero compacts nothing", !needsCompaction(full, 0));
  // The boundary itself, which is pi's rule and worth pinning: exactly at the reserve is fine,
  // one token over is not.
  const threshold = 128_000 - COMPACTION.reserveTokens;
  check(
    "the threshold is the window minus the reserve",
    !needsCompaction([assistantWithTotal(threshold)], 128_000) &&
      needsCompaction([assistantWithTotal(threshold + 1)], 128_000),
  );
}

// 2. Where the cut lands.
{
  const messages = conversation(40);
  const plan = planCompaction(messages, { ...COMPACTION, keepRecentTokens: 5_000 });
  check("a long conversation has a plan", plan !== null);
  check(
    "the kept tail starts where the user asked something",
    plan?.keep[0]?.role === "user",
    plan?.keep[0]?.role ?? "none",
  );
  check(
    "no message is lost or duplicated",
    (plan?.summarized.length ?? 0) + (plan?.keep.length ?? 0) === messages.length,
    `${plan?.summarized.length} + ${plan?.keep.length} of ${messages.length}`,
  );
  check(
    "the head is what is dropped, in order",
    plan?.summarized[0] === messages[0] && plan?.keep[0] === messages[(plan?.summarized.length ?? 0)],
  );

  const short = planCompaction(conversation(1), { ...COMPACTION, keepRecentTokens: 5_000 });
  check("a single turn has nothing older to summarize", short === null);
  check("and neither does an empty transcript", planCompaction([], COMPACTION) === null);

  // The tail must cover roughly the recent budget, and never the whole conversation.
  const tail = plan?.keep ?? [];
  const tailTokens = tail.reduce((total, message) => total + contextTokens([message]), 0);
  check(
    "the tail is at least the recent budget",
    tailTokens >= 5_000,
    `${tailTokens} tokens`,
  );
  check("and there is something left to summarize", (plan?.summarized.length ?? 0) > 0);
}

// 3. Summaries: iterative, and readable back.
{
  const first = summaryMessage("what happened first", 120_000);
  check("a summary is pi's own message", first.role === "compactionSummary", first.role);
  check("it reads back as the previous summary", previousSummary([first, user("next")]) === "what happened first");
  check("a conversation that was never compacted has none", previousSummary([user("hi")]) === undefined);
  check("an empty transcript has none", previousSummary([]) === undefined);
  check(
    "an empty summary is not a previous summary",
    previousSummary([summaryMessage("   ", 1_000)]) === undefined,
  );

  // The estimate has to count the summary, or the second compaction thinks nothing was freed.
  const summaryTokens = contextTokens([first]);
  check("the summary counts towards the context", summaryTokens > 0, `${summaryTokens} tokens`);
}

console.log(`\n${failures === 0 ? "all compaction checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
