import { createEffect, createSignal, For, Show } from "solid-js";
import { BrandMark } from "../../components/brand-mark";
import { formatBytes, type EngineId } from "../../lib/detect-format";
import "./chat-screen.css";

/** One thing in the transcript, in the order it happened. */
export type ChatLine =
  /** What the user typed or dropped. */
  | { readonly kind: "you"; readonly text: string }
  /**
   * The application speaking about itself: what it recognised, what it cannot do,
   * what it is waiting for. It is not a model's answer, and the transcript says so
   * rather than letting the two blur.
   */
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly size: number;
      readonly format: string;
      readonly detail: string;
      /** The analyser that can read this file, or null when nothing here can. */
      readonly engine: EngineId | null;
    };

export interface ChatScreenProps {
  readonly lines: readonly ChatLine[];
  readonly onSend: (text: string) => void;
  readonly onPick: (file: File | undefined) => void;
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
 * The conversation, which is the home surface.
 *
 * The shape is the one a chat interface has settled on: a column, a transcript that
 * scrolls, and a composer pinned under it. What this build can honestly put in the
 * transcript is narrow — no model is connected, so nothing answers — and the page
 * says that instead of showing a typing indicator over nothing.
 */
export function ChatScreen(props: ChatScreenProps) {
  const [text, setText] = createSignal("");
  let scroller: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;

  /*
   * Follow the end of the transcript. Unconditionally for now: a transcript this
   * build produces is short, and holding position while someone reads would need to
   * tell "user scrolled up" apart from "user is at the end", which needs the real
   * message list to be worth doing.
   */
  createEffect(
    () => props.lines.length,
    () => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    },
  );

  const canSend = () => text().trim().length > 0;

  const grow = () => {
    if (!input) return;
    // Reset first, or the box can only ever get taller.
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const value = text().trim();
    if (!value) return;
    props.onSend(value);
    setText("");
    if (input) {
      input.style.height = "auto";
      input.focus();
    }
  };



  return (
    <>
      <header class="top-bar">
        <div class="top-bar-group">
          <BrandMark />
          <span class="brand-name">Repi</span>
        </div>
        <nav class="top-bar-links" aria-label="About this project">
          <a class="top-bar-link" href="#/about" data-testid="about-link">
            About
          </a>
          <a class="top-bar-link" href="#/licenses">
            Licenses
          </a>
        </nav>
      </header>

      <main class="chat">
        <div class="chat-scroll" ref={scroller}>
          <div class="chat-column" role="log" aria-live="polite" data-testid="transcript">
            <Show when={props.lines.length === 0}>
              <section class="chat-welcome">
                <h1 class="chat-title">Drop a binary, or ask about one.</h1>
                <p class="chat-lede">
                  Analysis runs on this device. No model is connected yet, so the conversation does not
                  answer — dropping a file reports what it recognised and stops there.
                </p>
              </section>
            </Show>

            <For each={props.lines}>
              {(line) => (
                <div class="line" data-kind={line.kind}>
                  {/*
                    Three `Show`s rather than a `Switch`: the accessor form narrows
                    the union, so each branch reads its own fields without a cast.
                  */}
                  <Show when={line.kind === "you" ? line : null}>
                    {(you) => <p class="line-bubble">{you().text}</p>}
                  </Show>

                  <Show when={line.kind === "note" ? line : null}>
                    {(note) => (
                      <div class="line-note">
                        <span class="line-from">REPI</span>
                        <p class="line-text">{note().text}</p>
                      </div>
                    )}
                  </Show>

                  <Show when={line.kind === "file" ? line : null}>
                    {(file) => (
                      <article class="file-card" data-analysable={file().engine ? "true" : "false"}>
                        <p class="file-name">{file().name}</p>
                        <p class="file-facts">
                          {file().format} · {file().detail} · {formatBytes(file().size)}
                        </p>
                        <p class="file-engine">
                          {analyserSentence(file().engine)}
                        </p>
                      </article>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>

        <form
          class="composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div class="composer-column">
            <div class="composer-box">
              <label class="composer-attach" aria-label="Attach a binary">
                <input
                  class="visually-hidden"
                  type="file"
                  onChange={(event) => {
                    const picked = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    props.onPick(picked);
                  }}
                />
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </label>

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

              <button
                class="composer-send"
                type="submit"
                disabled={!canSend()}
                aria-label="Send"
                data-testid="send"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 13V3M4 7l4-4 4 4" />
                </svg>
              </button>
            </div>

            {/*
              Under the box rather than in it, and always visible: this is the claim
              the product is built on, and a claim that is only made on the welcome
              screen is a claim the user stops being able to check.
            */}
            <p class="composer-note">
              No model is connected yet — nothing you type, and no file you drop, leaves this device.
            </p>
          </div>
        </form>
      </main>
    </>
  );
}
