import { createEffect, createSignal, For, Show } from "solid-js";
import { Markdown } from "../../components/markdown";
import { formatBytes, type EngineId } from "../../lib/detect-format";
import { StructureField } from "../about/structure-field";
import { ModelSelector } from "../models/model-selector";
import type { ModelProvider } from "../models/types";
import type { ChatLine } from "./types";
import "./chat-screen.css";

export type { ChatLine } from "./types";

export interface ChatScreenProps {
  readonly conversationId: string;
  readonly lines: readonly ChatLine[];
  readonly onSend: (text: string) => void;
  readonly working: boolean;
  readonly onStop: () => void;
  readonly onPick: (file: File | undefined) => void;
  readonly fileWrite: { readonly name: string; readonly progress: number } | null;
  readonly providers: readonly ModelProvider[];
  readonly selectedModelKey: string | null;
  readonly onSelectModel: (key: string) => void;
  readonly onAddProvider: () => void;
  readonly onOpenSidebar: () => void;
}

/** Spelled out, so a third engine is a type error rather than a silent "undefined". */
const ENGINE_NAMES: Record<EngineId, string> = { kuna: "Kuna", rasc: "Rasc" };

/**
 * Whether anything in this build can read the file, said as a sentence.
 *
 * A helper rather than a ternary in the markup because `file().engine` is a call,
 * and TypeScript will not carry a narrowing across two of them.
 */
function analyserSentence(engine: EngineId | null): string {
  return engine === null
    ? "No analyser in this build reads this file."
    : `${ENGINE_NAMES[engine]} can read this file.`;
}

/**
 * The platform picker, behind a label that acts as the control.
 *
 * A component rather than a shared JSX value: a JSX value is a real DOM node, so
 * rendering the same one in two places would move it out of the first.
 */
function FileInput(props: {
  readonly onPick: (file: File | undefined) => void;
  readonly disabled: boolean;
}) {
  return (
    <input
      class="visually-hidden"
      type="file"
      disabled={props.disabled}
      onChange={(event) => {
        const picked = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        props.onPick(picked);
      }}
    />
  );
}

/**
 * The conversation, which is the home surface.
 *
 * Two states share one DOM: with nothing said yet the column is centred with a
 * greeting above the composer and two things to try under it, and once there is a
 * transcript it falls back to the top with the composer docked. The same composer
 * element is used for both, so sending the first message does not move the element
 * the caret is in — which is why this is one tree with a state attribute rather
 * than two trees behind a `Show`.
 */
export function ChatScreen(props: ChatScreenProps) {
  const [text, setText] = createSignal("");
  let scroller: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;

  const empty = () => props.lines.length === 0;

  /*
   * Follow the end of the transcript. Unconditionally for now: a transcript this
   * build produces is short, and holding position while someone reads would mean
   * telling "user scrolled up" apart from "user is at the end".
   */
  createEffect(
    () => `${props.conversationId}:${props.lines.length}`,
    () => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    },
  );

  // A draft belongs to the thread where it was typed. Until drafts are stored per
  // conversation, clearing it is safer than showing it under a different history row.
  createEffect(
    () => props.conversationId,
    () => {
      setText("");
      if (input) input.style.height = "auto";
    },
  );

  const selectedModelExists = () =>
    props.providers.some((provider) =>
      provider.models.some((model) => `${provider.id}:${model}` === props.selectedModelKey),
    );
  const canSend = () => text().trim().length > 0 && selectedModelExists() && !props.working;

  const grow = () => {
    if (!input) return;
    // Reset first, or the box can only ever get taller.
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const value = text().trim();
    if (!value || !canSend()) return;
    props.onSend(value);
    setText("");
    if (input) {
      input.style.height = "auto";
      input.focus();
    }
  };

  /*
   * `onPick` is passed down rather than closed over: a component is called per use,
   * while a JSX value would be one node that moves.
   */

  return (
    <main class="chat" data-empty={empty() ? "true" : "false"}>
      <button
        class="sidebar-trigger"
        type="button"
        aria-label="Open conversation history"
        onClick={props.onOpenSidebar}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <StructureField variant="quiet" />

      <div class="chat-scroll" ref={scroller}>
          <div class="chat-column" role="log" aria-live="polite" data-testid="transcript">
            <Show when={empty()}>
              <section class="chat-welcome">
                <h1 class="chat-greeting">
                  What are we <em>looking at</em>?
                </h1>
              </section>
            </Show>

            <For each={props.lines}>
              {(line) => (
                <div class="line" data-kind={line.kind}>
                  {/*
                    Separate `Show`s rather than a `Switch`: the accessor form narrows
                    the union, so each branch reads its own fields without a cast.
                  */}
                  <Show when={line.kind === "you" ? line : null}>
                    {(you) => <p class="line-bubble">{you().text}</p>}
                  </Show>

                  <Show when={line.kind === "note" ? line : null}>
                    {(note) => (
                      <div class="line-repi">
                        <span class="line-avatar" aria-hidden="true">
                          R
                        </span>
                        <div class="line-body">
                          <p class="line-from">Repi</p>
                          <p class="line-text">{note().text}</p>
                        </div>
                      </div>
                    )}
                  </Show>

                  <Show when={line.kind === "assistant" ? line : null}>
                    {(assistant) => (
                      <div class="line-repi">
                        <span class="line-avatar" aria-hidden="true">
                          R
                        </span>
                        <div class="line-body">
                          <p class="line-from">Repi</p>
                          <Show when={assistant().activity}>
                            {(activity) => <p class="line-activity">{activity()}</p>}
                          </Show>
                          <Show when={assistant().text} fallback={<span class="typing-indicator" aria-label="Thinking" />}>
                            <Markdown
                              text={assistant().text}
                              error={assistant().state === "error"}
                            />
                          </Show>
                        </div>
                      </div>
                    )}
                  </Show>

                  <Show when={line.kind === "file" ? line : null}>
                    {(file) => (
                      <div class="line-repi">
                        <span class="line-avatar" aria-hidden="true">
                          R
                        </span>
                        <div class="line-body">
                          <article class="file-card" data-analysable={file().engine ? "true" : "false"}>
                            <p class="file-name">{file().name}</p>
                            <p class="file-facts">
                              {file().format} · {file().detail} · {formatBytes(file().size)}
                            </p>
                            <div class="file-badges">
                              <p class="file-badge">{analyserSentence(file().engine)}</p>
                              <Show when={file().storedFileId}>
                                <p class="file-badge file-stored">Saved locally</p>
                              </Show>
                            </div>
                          </article>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="composer-column">
          <Show when={props.fileWrite}>
            {(write) => (
              <div class="file-write" role="status" aria-live="polite">
                <span class="file-write-name">Saving {write().name}</span>
                <span class="file-write-value">{Math.round(write().progress * 100)}%</span>
                <span class="file-write-track" aria-hidden="true">
                  <span style={{ width: `${write().progress * 100}%` }} />
                </span>
              </div>
            )}
          </Show>
          <form
            class="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div class="composer-box">
              <textarea
                class="composer-input"
                ref={(node) => (input = node)}
                rows={1}
                placeholder="Ask about a binary…"
                aria-label="Message"
                value={text()}
                onInput={(event) => {
                  setText(event.currentTarget.value);
                  grow();
                }}
                onKeyDown={(event) => {
                  // Enter sends and Shift+Enter starts a line, which is what a chat
                  // interface does; a touch keyboard's return key is a real newline,
                  // because Shift cannot be held on a glass keyboard.
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />

              <div class="composer-actions">
                <div class="composer-actions-start">
                  <label
                    class="composer-attach"
                    data-disabled={props.fileWrite || props.working ? "true" : "false"}
                    aria-label="Attach a binary"
                  >
                    <FileInput
                      onPick={props.onPick}
                      disabled={props.fileWrite !== null || props.working}
                    />
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </label>
                  <ModelSelector
                    providers={props.providers}
                    selectedKey={props.selectedModelKey}
                    onSelect={props.onSelectModel}
                    onAddProvider={props.onAddProvider}
                  />
                </div>

                <Show
                  when={props.working}
                  fallback={
                    <button
                      class="composer-send"
                      type="submit"
                      disabled={!canSend()}
                      aria-label={selectedModelExists() ? "Send" : "Choose a model before sending"}
                      data-testid="send"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 19V5M5 12l7-7 7 7" />
                      </svg>
                    </button>
                  }
                >
                  <button class="composer-send composer-stop" type="button" aria-label="Stop" onClick={props.onStop}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="7" y="7" width="10" height="10" />
                    </svg>
                  </button>
                </Show>
              </div>
            </div>
          </form>
        </div>
    </main>
  );
}
