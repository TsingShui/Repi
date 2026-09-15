import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EngineId } from "../../lib/detect-format";

/** One thing in a transcript, in the order it happened. */
export type ChatLine =
  | { readonly kind: "you"; readonly text: string }
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      readonly state: "streaming" | "complete" | "error";
      readonly activity?: string;
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly size: number;
      readonly format: string;
      readonly detail: string;
      readonly engine: EngineId | null;
      /** Omitted on conversations imported from the former localStorage store. */
      readonly storedFileId?: string;
    };

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

export interface Conversation extends ConversationSummary {
  readonly lines: readonly ChatLine[];
  /** `provider-id:model-id`; each conversation remembers its own selection. */
  readonly selectedModelKey?: string;
  /**
   * How much the model may think before answering, when it can think at all.
   *
   * Kept beside the model because the two are one decision: levels are model-specific, and the
   * same "high" means nothing on a model that does not reason. Absent means "off" — the level
   * this app has always run at, so upgrading does not silently start spending tokens.
   */
  readonly thinkingLevel?: ModelThinkingLevel;
  /**
   * Pi's provider/tool transcript, persisted separately from presentation lines.
   *
   * `AgentMessage` rather than `Message`, because a compacted conversation starts with pi's own
   * summary message — a role that never goes to a provider as it stands, and that pi's converter
   * turns into a `<summary>` block on the way out.
   */
  readonly agentMessages?: readonly AgentMessage[];
}
