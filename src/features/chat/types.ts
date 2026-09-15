import type { Message } from "@earendil-works/pi-ai";
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
  /** Pi's provider/tool transcript, persisted separately from presentation lines. */
  readonly agentMessages?: readonly Message[];
}
