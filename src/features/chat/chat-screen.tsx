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
   * what it is waiting for. It is not a model's answer, and the transcript tells
   * them apart rather than letting the two blur.
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
 * The platform picker, behind a label that acts as the control.
 *
 * A component rather than a shared JSX value: a JSX value is a real DOM node, so
 * rendering the same one in two places would move it out of the first.
 */
function FileInput(props: { readonly onPick: (file: File | undefined) => void }) {
  return (
    <input
      class="visually-hidden"
      type="file"
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

  /*
   * `onPick` is passed down rather than closed over: a component is called per use,
   * while a JSX value would be one node that moves.
   */

  return (
    <>
      <header class="top-bar">
        <div class="top-bar-group">
          <BrandMark />
          <span class="brand-name">Repi</span>
          {/*
            The state of the thing the page is for, where a chat header usually puts
            the model it is talking to. A pill and not a control: there is no menu
            behind it, and no chevron pretending there is.
          */}
          <span class="model-pill" data-testid="model-pill">
            <span class="model-dot" aria-hidden="true" />
            No model
          </span>
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

      <main class="chat" data-empty={empty() ? "true" : "false"}>
        <div class="chat-scroll" ref={scroller}>
          <div class="chat-column" role="log" aria-live="polite" data-testid="transcript">
            <Show when={empty()}>
              <section class="chat-welcome">
                <h1 class="chat-greeting">
                  What are we <em>looking at</em>?
                </h1>
                <p class="chat-lede">
                  Analysis runs on this device. Drop a binary and I will say what it is — the
                  conversation itself does not answer yet.
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
                            <p class="file-badge">{analyserSentence(file().engine)}</p>
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
          <form
            class="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div class="composer-box">
              <label class="composer-attach" aria-label="Attach a binary">
                <FileInput onPick={props.onPick} />
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
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
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </form>

          <p class="composer-note">
            No model is connected — nothing you type, and no file you drop, leaves this device.
          </p>
        </div>
      </main>
    </>
  );
}
