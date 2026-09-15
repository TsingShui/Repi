/**
 * How full the conversation is.
 *
 * A conversation with tools in it grows in jumps: one `rasc` call that returns a class list is
 * thousands of tokens the user never typed, and the first sign of trouble is a provider refusing
 * the request. The number that predicts that is the size of the last exchange — the prompt that
 * was sent plus the answer that came back, which is what the next prompt will carry again.
 *
 * `Usage.totalTokens` is pi's own accounting of exactly that, and it is comparable across
 * providers because pi builds it the same way from each one's numbers (prompt, completion and
 * cache reads kept apart rather than folded together).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Tokens the last exchange carried: the best estimate of what the next request will send. */
export function contextUsed(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const total = message.usage?.totalTokens;
    if (typeof total === "number" && total > 0) return total;
  }
  return 0;
}

/**
 * A token count as a person reads it.
 *
 * Not `Intl.NumberFormat` with a compact notation: that gives "128K" for one number and "12.4K"
 * for another depending on the locale's idea of significant digits, and two numbers side by side
 * are easier to compare when they are built the same way.
 *
 * The boundaries are chosen for what the number is for: exact below a thousand, where 400 and 900
 * are different situations; one decimal below a hundred thousand, which is where approaching a
 * window is decided (124.5K of 128K is a different position from 124K); rounded thousands above
 * that, where a tenth of a thousand is noise.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}K`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** How full the window is, 0–100, with anything past full pinned at 100. */
export function contextPercent(used: number, contextWindow: number): number {
  if (!Number.isFinite(used) || used <= 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(100, (used / contextWindow) * 100);
}

/** One line for the record: what is used, what there is, and whether the ceiling is known. */
export function contextSentence(
  used: number,
  contextWindow: number,
  assumed: boolean,
): string {
  const ceiling = assumed
    ? `${contextWindow.toLocaleString()} tokens (the endpoint does not report a window, so this app assumes one)`
    : `${contextWindow.toLocaleString()} tokens`;
  return `Context: about ${used.toLocaleString()} of ${ceiling} used by the last exchange.`;
}
