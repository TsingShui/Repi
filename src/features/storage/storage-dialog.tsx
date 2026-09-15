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
  readonly onKeep: () => Promise<"granted" | "denied" | "unsupported">;
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

type TreeNode =
  | {
      readonly kind: "dir";
      readonly name: string;
      readonly key: string;
      readonly children: readonly TreeNode[];
      readonly bytes: number;
      readonly files: number;
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly key: string;
      readonly id: string;
      readonly bytes: number;
      readonly facts: string;
    };

interface DirBuilder {
  readonly name: string;
  readonly key: string;
  readonly dirs: Map<string, DirBuilder>;
  readonly files: TreeNode[];
}

function newDir(name: string, key: string): DirBuilder {
  return { name, key, dirs: new Map(), files: [] };
}

/**
 * Turns the stored records into the tree the sandbox actually has.
 *
 * Two roots, because the two kinds of file live in different places and there is no reason to
 * pretend otherwise: `work/` is the filesystem a program sees (built from the paths of the
 * files engines produced, so a library extracted from an APK sits where it was extracted),
 * and `conversations/` holds the binaries someone attached, which belong to a conversation
 * rather than to the sandbox.
 */
function buildTree(
  files: readonly StoredFile[],
  contexts: ReadonlyMap<string, FileContext>,
): readonly TreeNode[] {
  const work = newDir("work", "work");
  const attached = newDir("conversations", "conversations");

  for (const file of files) {
    if (file.origin === "derived" && file.path) {
      const parts = file.path.split("/").filter((part) => part !== "" && part !== "work");
      const name = parts.pop() ?? file.name;
      let at = work;
      for (const part of parts) {
        let next = at.dirs.get(part);
        if (!next) {
          next = newDir(part, `${at.key}/${part}`);
          at.dirs.set(part, next);
        }
        at = next;
      }
      at.files.push({
        kind: "file",
        name,
        key: file.path,
        id: file.id,
        bytes: file.size,
        facts: `${formatBytes(file.size)} · ${shortDate(file.createdAt)}`,
      });
      continue;
    }

    const context = contexts.get(file.id);
    const owner = context?.conversation ?? "Conversation deleted";
    const key = `conversation:${owner}`;
    let dir = attached.dirs.get(key);
    if (!dir) {
      dir = newDir(owner, key);
      attached.dirs.set(key, dir);
    }
    dir.files.push({
      kind: "file",
      name: file.name,
      key: `file:${file.id}`,
      id: file.id,
      bytes: file.size,
      facts: `${formatBytes(file.size)} · ${shortDate(file.createdAt)}`,
    });
  }

  const sealed = (builder: DirBuilder): TreeNode => {
    const children = [
      ...[...builder.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(sealed),
      ...[...builder.files].sort((a, b) => a.name.localeCompare(b.name)),
    ];
    return {
      kind: "dir",
      name: builder.name,
      key: builder.key,
      children,
      bytes: children.reduce((total, child) => total + child.bytes, 0),
      files: children.reduce((total, child) => total + (child.kind === "dir" ? child.files : 1), 0),
    };
  };

  return [sealed(work), sealed(attached)].filter((node) => node.kind === "dir" && node.children.length > 0);
}

/**
 * One row of the tree: a folder that opens, or a file with its size and a way to delete it.
 *
 * A folder is drawn from the paths themselves, so a library extracted from an APK appears at
 * the path it was extracted to — `/work/lib/arm64-v8a/libfoo.so` — and a person reading the
 * panel is looking at the same layout a program does.
 */
function TreeRow(props: {
  readonly node: TreeNode;
  readonly depth: number;
  readonly busy: () => boolean;
  readonly remove: (id: string) => void;
}) {
  const [open, setOpen] = createSignal(true);
  /*
   * The object is written out at each use rather than returned from a helper: Solid only
   * routes `style` through its style helper when it can see an object literal, and a call
   * expression is assigned to `node.style` instead — where an object silently does nothing.
   */
  const indent = () => 12 + props.depth * 16;
  // `Show` decides which branch renders, but not which variant TypeScript is looking at.
  const file = () => props.node as Extract<TreeNode, { kind: "file" }>;

  return (
    <li class="storage-tree-node">
      <Show
        when={props.node.kind === "dir" ? props.node : null}
        fallback={
          <div class="storage-tree-row" data-kind="file" style={{ "padding-left": `${indent()}px` }}>
            <span class="storage-tree-spacer" aria-hidden="true" />
            <span class="storage-file-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 3h8l4 4v14H6z" />
                <path d="M14 3v4h4" />
              </svg>
            </span>
            <span class="storage-file-copy">
              <span class="storage-file-name" title={file().name}>
                {file().name}
              </span>
              <span class="storage-file-facts">{file().facts}</span>
            </span>
            <button
              type="button"
              class="storage-file-delete"
              aria-label={`Delete ${file().name} from this browser`}
              title="Delete this local copy"
              disabled={props.busy()}
              onClick={() => props.remove(file().id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
              </svg>
            </button>
          </div>
        }
      >
        {(dir) => (
          <>
            <button
              type="button"
              class="storage-tree-row"
              data-kind="dir"
              aria-expanded={open() ? "true" : "false"}
              style={{ "padding-left": `${indent()}px` }}
              onClick={() => setOpen((value) => !value)}
            >
              <span class="storage-tree-toggle" data-open={open() ? "true" : "false"} aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
              <span class="storage-tree-folder" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
              </span>
              <span class="storage-file-copy">
                <span class="storage-file-name">{dir().name}/</span>
                <span class="storage-file-facts">
                  {dir().files} file{dir().files === 1 ? "" : "s"} · {formatBytes(dir().bytes)}
                </span>
              </span>
            </button>
            <Show when={open()}>
              <ul class="storage-tree-children">
                <For each={dir().children}>
                  {(child) => (
                    <TreeRow node={child} depth={props.depth + 1} busy={props.busy} remove={props.remove} />
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </li>
  );
}

export function StorageDialog(props: StorageDialogProps) {
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [confirmingAll, setConfirmingAll] = createSignal(false);
  /** What the browser answered when asked to keep this storage. Null: not asked yet. */
  const [keepVerdict, setKeepVerdict] = createSignal<"granted" | "denied" | "unsupported" | null>(null);
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
  /*
   * Two kinds of thing live here, and they are not the same kind of thing: a binary someone
   * dropped in, and a file an engine produced. The second is the sandbox's filesystem — every
   * conversation can open it — so it is listed by the path a program would use, not by which
   * attachment it came from.
   */
  const tree = () => buildTree(props.files, contexts());
  /** The tree's own total, so the status line and the rows are the same arithmetic. */
  const treeBytes = () => tree().reduce((total, node) => total + node.bytes, 0);
  const treeFiles = () =>
    tree().reduce((total, node) => total + (node.kind === "dir" ? node.files : 1), 0);
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

      {/*
        A status line, not a dashboard: the tree is the content, and the one number a person
        needs from it is what it adds up to. Both figures come from the tree above, so they
        cannot disagree with the rows below them.
      */}
      <section class="storage-status" data-level={usageLevel(props.usage)} aria-label="Capacity">
        <div class="storage-status-line">
          <strong>{formatBytes(treeBytes())}</strong>
          <span class="storage-status-files">
            {treeFiles()} file{treeFiles() === 1 ? "" : "s"}
          </span>
          <span class="storage-status-quota">
            {usageValue(props.usage) ?? "—"}
            {props.usage?.quota === null || props.usage === null
              ? " of an unknown quota"
              : ` of ${formatBytes(props.usage.quota)}`}
            {usagePercent(props.usage) === null ? "" : ` · ${Math.round(usagePercent(props.usage) ?? 0)}%`}
          </span>
          <span class="storage-chip">{props.usage?.backend === "indexeddb" ? "IndexedDB" : "OPFS"}</span>
          <span class="storage-chip" data-retention={props.usage?.persisted ? "persistent" : "best-effort"}>
            {props.usage?.persisted ? "Persistent" : "Best effort"}
          </span>
          <Show when={props.usage && !props.usage.persisted && keepVerdict() === null}>
            <button
              type="button"
              class="storage-keep-inline"
              onClick={() => void props.onKeep().then(setKeepVerdict)}
            >
              Ask the browser to keep it
            </button>
          </Show>
        </div>
        <span class="storage-status-track" aria-hidden="true">
          <span class="storage-status-fill" style={{ width: `${usagePercent(props.usage)}%` }} />
        </span>
        {/*
          What the browser said, in its own terms. Chromium answers this from its heuristics
          and never prompts, so "nothing happened" would be the whole story unless it is said
          here — and once the answer is known the button goes, because asking twice cannot
          change it.
        */}
        <Show when={keepVerdict() !== null || props.usage?.persisted}>
          <p class="storage-status-note">
            {props.usage?.persisted
              ? "This browser will keep these files until you delete them."
              : keepVerdict() === "granted"
                ? "Granted. These files will be kept until you delete them."
                : keepVerdict() === "unsupported"
                  ? "This browser does not let a page ask, so these files are best-effort."
                  : "The browser declined, and it decides for itself: it grants this to installed apps and to sites used often, with no prompt to accept. Until then these files are best-effort — the browser may drop them when the device runs short of space."}
          </p>
        </Show>
      </section>

      <Show when={props.error}>{(message) => <p class="storage-error" role="alert">{message()}</p>}</Show>

      <section class="storage-tree" aria-label="Stored files">
        <div class="storage-files-head">
          <span>Stored files</span>
          <Show when={props.files.length > 0}>
            <span class="storage-files-total">
              {treeFiles()} file{treeFiles() === 1 ? "" : "s"} · {formatBytes(treeBytes())}
            </span>
          </Show>
        </div>

        <Show
          when={tree().length > 0}
          fallback={
            <p class="storage-empty">
              Nothing is stored yet. A binary dropped into a conversation is kept here, and a
              file an engine produces joins it in the sandbox’s filesystem.
            </p>
          }
        >
          <ul class="storage-tree-root">
            <For each={tree()}>
              {(node) => (
                <TreeRow node={node} depth={0} busy={() => busyId() !== null} remove={(id) => void remove(id)} />
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
