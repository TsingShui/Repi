import { createEffect, createSignal, For, Show } from "solid-js";
import { formatBytes, type EngineId } from "../../lib/detect-format";
import type { StoredFile, StorageUsage } from "../../lib/storage/workspace-storage";
import type { Conversation } from "../chat/types";
import { usageLevel, usagePercent, usageValue } from "./usage";
import "./storage-dialog.css";

export interface StorageDialogProps {
  readonly open: boolean;
  readonly usage: StorageUsage | null;
  readonly files: readonly StoredFile[];
  readonly conversations: readonly Conversation[];
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onDeleteFile: (id: string) => Promise<void>;
  readonly onDeleteAll: () => Promise<void>;
  readonly onKeep: () => Promise<void>;
}

/** What the transcript already knows about a cached file, offered back in the panel. */
interface FileContext {
  readonly format: string;
  readonly detail: string;
  readonly engine: EngineId | null;
  readonly conversation: string;
}

/**
 * Joins the cache against the conversations that own it.
 *
 * The stored record deliberately holds no presentation facts; the card in the
 * transcript does. Reading them from there keeps one description of a file rather
 * than two that can disagree.
 */
function contextsOf(
  files: readonly StoredFile[],
  conversations: readonly Conversation[],
): Map<string, FileContext> {
  const contexts = new Map<string, FileContext>();
  for (const conversation of conversations) {
    for (const line of conversation.lines) {
      if (line.kind !== "file" || !line.storedFileId) continue;
      if (!files.some((file) => file.id === line.storedFileId)) continue;
      contexts.set(line.storedFileId, {
        format: line.format,
        detail: line.detail,
        engine: line.engine,
        conversation: conversation.title,
      });
    }
  }
  return contexts;
}

function shortDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

export function StorageDialog(props: StorageDialogProps) {
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [confirmingAll, setConfirmingAll] = createSignal(false);
  let dialog: HTMLDialogElement | undefined;

  createEffect(
    () => props.open,
    (open) => {
      if (!dialog) return;
      if (open && !dialog.open) {
        setConfirmingAll(false);
        dialog.showModal();
      } else if (!open && dialog.open) {
        dialog.close();
      }
    },
  );

  const contexts = () => contextsOf(props.files, props.conversations);
  const cachedBytes = () => props.files.reduce((total, file) => total + file.size, 0);
  const close = () => props.onClose();

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await props.onDeleteFile(id);
    } finally {
      setBusyId(null);
    }
  };

  const removeAll = async () => {
    if (!confirmingAll()) {
      setConfirmingAll(true);
      return;
    }
    await props.onDeleteAll();
    setConfirmingAll(false);
  };

  return (
    <dialog
      class="storage-dialog"
      ref={(node) => (dialog = node)}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        if (props.open) props.onClose();
      }}
    >
      <div class="storage-dialog-head">
        <div>
          <h2>Local storage</h2>
          <p>What this browser is keeping for Repi.</p>
        </div>
        <button type="button" class="storage-dialog-close" aria-label="Close" onClick={close}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <section class="storage-summary" data-level={usageLevel(props.usage)} aria-label="Capacity">
        <div class="storage-summary-figures">
          <strong>{usageValue(props.usage) ?? "—"}</strong>
          <span>
            {props.usage?.quota === null || props.usage === null
              ? "of an unknown quota"
              : `of ${formatBytes(props.usage.quota)}`}
          </span>
        </div>
        <span class="storage-summary-track" aria-hidden="true">
          <span class="storage-summary-fill" style={{ width: `${usagePercent(props.usage)}%` }} />
        </span>
        <div class="storage-summary-meta">
          <span class="storage-chip">{props.usage?.backend === "indexeddb" ? "IndexedDB" : "OPFS"}</span>
          <span class="storage-chip" data-retention={props.usage?.persisted ? "persistent" : "best-effort"}>
            {props.usage?.persisted ? "Persistent" : "Best effort"}
          </span>
          <span class="storage-chip">
            {props.files.length} file{props.files.length === 1 ? "" : "s"}
          </span>
        </div>

        <Show when={props.usage && !props.usage.persisted}>
          <div class="storage-keep">
            <p>Best effort means the browser may drop this when the device runs out of space.</p>
            <button type="button" onClick={() => void props.onKeep()}>
              Ask the browser to keep it
            </button>
          </div>
        </Show>
      </section>

      <Show when={props.error}>{(message) => <p class="storage-error" role="alert">{message()}</p>}</Show>

      <section class="storage-files" aria-label="Cached files">
        <div class="storage-files-head">
          <span>Cached binaries</span>
          <Show when={props.files.length > 0}>
            <span class="storage-files-total">{formatBytes(cachedBytes())}</span>
          </Show>
        </div>

        <Show
          when={props.files.length > 0}
          fallback={
            <p class="storage-empty">
              Nothing is stored yet. A binary dropped into a conversation is kept here, on this device.
            </p>
          }
        >
          <ul class="storage-file-list">
            <For each={props.files}>
              {(file) => (
                <li class="storage-file" data-busy={busyId() === file.id ? "true" : "false"}>
                  <span class="storage-file-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M6 3h8l4 4v14H6z" />
                      <path d="M14 3v4h4" />
                    </svg>
                  </span>
                  <span class="storage-file-copy">
                    <span class="storage-file-name" title={file.name}>{file.name}</span>
                    <span class="storage-file-facts">
                      {contexts().get(file.id)
                        ? `${contexts().get(file.id)!.format} · ${contexts().get(file.id)!.detail}`
                        : "Recorded before Repi kept this detail"}
                      {" · "}
                      {formatBytes(file.size)}
                      {" · "}
                      {shortDate(file.createdAt)}
                    </span>
                    <span class="storage-file-origin">
                      {contexts().get(file.id)?.conversation ?? "Conversation deleted"}
                    </span>
                  </span>
                  <button
                    type="button"
                    class="storage-file-delete"
                    aria-label={`Delete ${file.name} from this browser`}
                    title="Delete this local copy"
                    disabled={busyId() !== null}
                    onClick={() => void remove(file.id)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
                    </svg>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <div class="storage-dialog-foot">
        <p>Deleting a file here removes Repi’s copy, never the original on your device.</p>
        {/*
          Always present. Hiding it when there was little to clear made the footer
          look like a panel with no way to empty it; disabled says the same thing
          without moving the control around.
        */}
        <button
          type="button"
          class="storage-remove-all"
          data-confirming={confirmingAll() ? "true" : "false"}
          disabled={props.files.length === 0 || busyId() !== null}
          onClick={() => void removeAll()}
        >
          {confirmingAll() ? "Tap again to clear" : "Clear all"}
        </button>
      </div>
    </dialog>
  );
}
