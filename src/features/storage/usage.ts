import { formatBytes } from "../../lib/detect-format";
import type { StorageUsage } from "../../lib/storage/workspace-storage";

/**
 * How a browser storage estimate reads to a person.
 *
 * Two surfaces show the same capacity — the rail's meter and the panel it opens — so
 * the number, the wording and the severity live here rather than in either of them.
 * Everything is derived from the estimate; nothing here talks to the browser.
 */

export type UsageLevel = "local" | "working" | "danger";

/** A browser that refuses to estimate reports null, which is not the same as empty. */
export function usageKnown(usage: StorageUsage | null): boolean {
  return usage !== null && usage.usage !== null;
}

export function usageValue(usage: StorageUsage | null): string | null {
  return usageKnown(usage) ? formatBytes(usage!.usage!) : null;
}

/**
 * Used share of the quota, as a percentage.
 *
 * A non-empty usage gets a visible sliver: rounding 300 KB of 10 GB down to 0% would
 * say "empty" about a store that is not, and the bar is the only place that shows it.
 */
export function usagePercent(usage: StorageUsage | null): number {
  if (!usage || usage.usage === null || usage.quota === null || usage.quota <= 0) return 0;
  if (usage.usage <= 0) return 0;
  return Math.min(100, Math.max((usage.usage / usage.quota) * 100, 1.5));
}

export function usageLevel(usage: StorageUsage | null): UsageLevel {
  const percent = usagePercent(usage);
  if (percent >= 90) return "danger";
  if (percent >= 75) return "working";
  return "local";
}

/** The line under the meter: what the capacity is, where the bytes live, how safe. */
export function usageNote(usage: StorageUsage | null): string {
  if (!usage) return "Checking local storage…";
  const backend = usage.backend === "opfs" ? "OPFS" : "IndexedDB";
  const retention = usage.persisted ? "persistent" : "best effort";
  return usage.quota === null ? `${backend} · ${retention}` : `of ${formatBytes(usage.quota)} · ${backend} · ${retention}`;
}

/** The same facts as one spoken sentence, because a meter is not readable aloud. */
export function usageSentence(usage: StorageUsage | null, error: string | null): string {
  if (error) return `Local storage: ${error}. Open what is cached.`;
  if (!usage) return "Local storage: checking. Open what is cached.";
  const used = usageValue(usage) ?? "an unknown amount";
  const quota = usage.quota === null ? "an unknown quota" : formatBytes(usage.quota);
  const retention = usage.persisted ? "persistent" : "best effort";
  return `Local storage: ${used} of ${quota}, ${usage.backend === "opfs" ? "OPFS" : "IndexedDB"}, ${retention}. Open what is cached.`;
}
