import { For, Show } from "solid-js";
import { BrandMark } from "../../components/brand-mark";
import type { DeviceSidebarState } from "../devices/device-store";
import type { StorageUsage } from "../../lib/storage/workspace-storage";
import { usageLevel, usageNote, usagePercent, usageSentence, usageValue } from "../storage/usage";
import type { Conversation } from "./types";
import "./conversation-sidebar.css";

export interface ConversationSidebarProps {
  readonly conversations: readonly Conversation[];
  readonly activeId: string;
  readonly open: boolean;
  readonly ready: boolean;
  readonly storageError: string | null;
  readonly usage: StorageUsage | null;
  readonly device: DeviceSidebarState;
  readonly onNew: () => void;
  readonly onSelect: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onAddProvider: () => void;
  readonly onOpenDevice: () => void;
  readonly onOpenStorage: () => void;
  readonly onClose: () => void;
}

function deviceLabel(device: DeviceSidebarState): string {
  switch (device.status) {
    case "connected":
      return device.name ?? "Connected";
    case "connecting":
      return "Connecting…";
    case "unsupported":
      return "WebUSB unavailable";
    case "error":
      return "Reconnect device";
    default:
      return "Connect Android";
  }
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

        <button
          class="storage-meter"
          type="button"
          data-level={usageLevel(props.usage)}
          data-error={props.storageError ? "true" : "false"}
          aria-label={usageSentence(props.usage, props.storageError)}
          onClick={props.onOpenStorage}
        >
          <span class="storage-meter-head">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <ellipse cx="12" cy="5" rx="7" ry="3" />
              <path d="M5 5v10c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 10c0 1.7 3.1 3 7 3s7-1.3 7-3" />
            </svg>
            <span class="storage-meter-label">Storage</span>
            <span class="storage-meter-track" aria-hidden="true">
              <span class="storage-meter-fill" style={{ width: `${usagePercent(props.usage)}%` }} />
            </span>
            <Show when={usageValue(props.usage)}>
              {(value) => <small class="storage-meter-value">{value()}</small>}
            </Show>
          </span>
          <small class="storage-meter-note" title={props.storageError ?? usageNote(props.usage)}>
            {props.storageError ?? usageNote(props.usage)}
          </small>
        </button>

        <button
          class="sidebar-device"
          type="button"
          data-status={props.device.status}
          onClick={props.onOpenDevice}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="7" y="3" width="10" height="18" rx="2" />
            <path d="M10 6h4M11.5 18h1" />
          </svg>
          <span class="sidebar-device-copy">
            <span>Device</span>
            <small>{deviceLabel(props.device)}</small>
          </span>
          <span class="sidebar-device-dot" aria-hidden="true" />
        </button>

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
