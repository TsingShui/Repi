import { For } from "solid-js";
import { BrandMark } from "../../components/brand-mark";
import { formatBytes } from "../../lib/detect-format";
import type { StorageUsage } from "../../lib/storage/workspace-storage";
import type { Conversation } from "./types";
import "./conversation-sidebar.css";

export interface ConversationSidebarProps {
  readonly conversations: readonly Conversation[];
  readonly activeId: string;
  readonly open: boolean;
  readonly ready: boolean;
  readonly storageError: string | null;
  readonly usage: StorageUsage | null;
  readonly onNew: () => void;
  readonly onSelect: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onAddProvider: () => void;
  readonly onClose: () => void;
}

function usageLabel(usage: StorageUsage | null): string {
  if (!usage) return "Checking local storage…";
  const backend = usage.backend === "opfs" ? "OPFS" : "IndexedDB";
  const retention = usage.persisted ? "persistent" : "best effort";
  if (usage.usage === null || usage.quota === null) return `${backend} · ${retention}`;
  return `${formatBytes(usage.usage)} of ${formatBytes(usage.quota)} · ${backend} · ${retention}`;
}

function relativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function ConversationSidebar(props: ConversationSidebarProps) {
  return (
    <>
      <button
        class="sidebar-scrim"
        type="button"
        data-open={props.open ? "true" : "false"}
        aria-label="Close conversation history"
        onClick={props.onClose}
      />

      <aside
        class="conversation-sidebar"
        data-open={props.open ? "true" : "false"}
        aria-label="Conversation history"
      >
        <div class="sidebar-head">
          <a class="sidebar-brand" href="#" aria-label="Repi home" onClick={props.onClose}>
            <BrandMark />
            <span>Repi</span>
          </a>
          <button class="sidebar-close" type="button" aria-label="Close sidebar" onClick={props.onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <button class="new-conversation" type="button" disabled={!props.ready} onClick={props.onNew}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New conversation
        </button>

        <div class="conversation-history">
          <p class="history-label">Recent</p>
          <div class="conversation-list" aria-busy={props.ready ? "false" : "true"}>
            <For each={props.conversations}>
              {(conversation) => (
                <div
                  class="conversation-item"
                  data-active={conversation.id === props.activeId ? "true" : "false"}
                >
                  <button
                    class="conversation-select"
                    type="button"
                    aria-current={conversation.id === props.activeId ? "page" : undefined}
                    disabled={!props.ready}
                    onClick={() => props.onSelect(conversation.id)}
                  >
                    <span class="conversation-title">{conversation.title}</span>
                    <span class="conversation-date">{relativeDate(conversation.updatedAt)}</span>
                  </button>
                  <button
                    class="conversation-delete"
                    type="button"
                    aria-label={`Delete ${conversation.title}`}
                    title="Delete conversation"
                    disabled={!props.ready}
                    onClick={() => props.onDelete(conversation.id)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
                    </svg>
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="storage-status" data-error={props.storageError ? "true" : "false"}>
          <span class="storage-dot" aria-hidden="true" />
          <span>{props.storageError ?? usageLabel(props.usage)}</span>
        </div>

        <button class="sidebar-model" type="button" onClick={props.onAddProvider}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Model
        </button>

        <a class="sidebar-about" href="#/about" onClick={props.onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7.5v.5" />
          </svg>
          About
        </a>
      </aside>
    </>
  );
}
