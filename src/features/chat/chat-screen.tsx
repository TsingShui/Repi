import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Markdown } from "../../components/markdown";
import { formatBytes, type EngineId } from "../../lib/detect-format";
import { StructureField } from "../about/structure-field";
import { ModelSelector } from "../models/model-selector";
import { ThinkingSelector } from "../models/thinking-selector";
import { ContextMeter } from "./context-meter";
import { applyMenuPlacement, placeMenu } from "../../lib/menu-placement";
import { MentionMenu } from "./mention-menu";
import {
  insertMention,
  matchMentions,
  mentionToken,
  parseMentions,
  type MentionTarget,
} from "./mentions";
import type { ModelLimits } from "../models/model-facts";
import type { ModelProvider } from "../models/types";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ChatLine } from "./types";
import "./chat-screen.css";

export type { ChatLine } from "./types";

export interface ChatScreenProps {
  readonly conversationId: string;
  readonly lines: readonly ChatLine[];
  /** Sends the message, with the files it mentions resolved and handed over. */
  readonly onSend: (text: string, mentions: readonly MentionTarget[]) => void;
  /** Everything the user can point at with `@`. */
  readonly mentionTargets: readonly MentionTarget[];
  readonly working: boolean;
  readonly onStop: () => void;
  readonly onPick: (file: File | undefined) => void;
  readonly fileWrite: { readonly name: string; readonly progress: number } | null;
  readonly providers: readonly ModelProvider[];
  readonly selectedModelKey: string | null;
  /** Levels the selected model accepts; one level (or none) hides the control. */
  readonly thinkingLevels: readonly ModelThinkingLevel[];
  readonly thinkingLevel: ModelThinkingLevel;
  readonly onSelectThinkingLevel: (level: ModelThinkingLevel) => void;
  /** Tokens the last exchange carried, and what this model can hold. */
  readonly contextUsed: number;
  readonly modelLimits: ModelLimits | null;
  /**
   * Whether summarizing would free room now, and how to do it.
   *
   * Offered when the next request would cross pi's threshold rather than on a timer: before that
   * the conversation is fine, and a button that says otherwise is a button that nags.
   */
  readonly canCompact: boolean;
  readonly onCompact: () => void;
  readonly onSelectModel: (key: string) => void;
  readonly onAddProvider: () => void;
  readonly onOpenSidebar: () => void;
}

/** Spelled out, so a third engine is a type error rather than a silent "undefined". */
const ENGINE_NAMES: Record<EngineId, string> = { kuna: "Kuna", rasc: "Rasc" };

const GREETINGS = [
  { lead: "What are we", focus: "looking at?" },
  { lead: "Where does execution", focus: "begin?" },
  { lead: "What deserves a", focus: "closer look?" },
  { lead: "What is hiding", focus: "in here?" },
  { lead: "Emmmm,", focus: "Capture The Flag?" },
] as const;

const STARTER_PROMPTS = [
  "Summarize this binary",
  "Find suspicious strings",
  "Trace the entry point",
] as const;

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
  /*
   * The `@` menu, as state: which token is being typed and which row is highlighted. The token is
   * recomputed from the message and the caret rather than remembered as a range, so editing the
   * sentence never leaves the menu pointing at text that has moved.
   */
  const [mention, setMention] = createSignal<{ start: number; end: number; query: string } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = createSignal(0);
  let mentionAnchor: HTMLDivElement | undefined;
  const mentionMatches = () => {
    const token = mention();
    return token === null ? [] : matchMentions(props.mentionTargets, token.query);
  };
  const [greetingIndex, setGreetingIndex] = createSignal(
    Math.floor(Math.random() * GREETINGS.length),
  );
  const [greetingPhase, setGreetingPhase] = createSignal<"visible" | "out" | "in">("visible");
  let scroller: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;

  const empty = () => props.lines.length === 0;
  const greeting = () => GREETINGS[greetingIndex()]!;

  let greetingTimer: number | undefined;
  let greetingSwapTimer: number | undefined;
  let greetingFrame = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stopGreetingCycle = () => {
    if (greetingTimer !== undefined) window.clearInterval(greetingTimer);
    if (greetingSwapTimer !== undefined) window.clearTimeout(greetingSwapTimer);
    window.cancelAnimationFrame(greetingFrame);
    greetingTimer = undefined;
    greetingSwapTimer = undefined;
    greetingFrame = 0;
  };

  const finishGreetingExit = () => {
    if (greetingPhase() !== "out") return;
    if (greetingSwapTimer !== undefined) window.clearTimeout(greetingSwapTimer);
    greetingSwapTimer = undefined;

    // The old words are fully transparent now. Swap while hidden, put the new
    // words at their entrance position, then reveal them on the following frame.
    setGreetingIndex((current) => (current + 1) % GREETINGS.length);
    setGreetingPhase("in");
    greetingFrame = window.requestAnimationFrame(() => {
      greetingFrame = window.requestAnimationFrame(() => setGreetingPhase("visible"));
    });
  };

  const cycleGreeting = () => {
    // Keep the old words in place while they leave. `transitionend` performs the
    // swap; this timeout is only a fallback if the browser suppresses that event.
    setGreetingPhase("out");
    greetingSwapTimer = window.setTimeout(finishGreetingExit, 320);
  };

  createEffect(empty, (isEmpty) => {
    stopGreetingCycle();
    setGreetingPhase("visible");
    if (isEmpty && !reducedMotion) {
      greetingTimer = window.setInterval(cycleGreeting, 4800);
    }
  });
  onCleanup(stopGreetingCycle);

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

  const chooseStarter = (prompt: string) => {
    setText(prompt);
    queueMicrotask(() => {
      grow();
      input?.focus();
    });
  };

  /** Recomputes what the caret is inside of, and offers the files that match it. */
  const updateMention = (area: HTMLTextAreaElement) => {
    const token = mentionToken(area.value, area.selectionStart ?? area.value.length);
    setMention(token);
    setMentionIndex(0);
    if (token !== null) placeMentionMenu(area);
  };

  /** Takes the chosen file: the name replaces what was typed, and the caret moves past it. */
  const acceptMention = (target: MentionTarget) => {
    const token = mention();
    if (token === null || !input) return;
    const written = insertMention(input.value, token, target.id);
    setText(written.text);
    setMention(null);
    // After the value is set, not before: the caret can only be placed in text that exists.
    queueMicrotask(() => {
      input?.focus();
      input?.setSelectionRange(written.caret, written.caret);
      grow();
    });
  };

  /*
   * The menu opens above the composer, where there is room: `placeMenu` decides which side, and
   * the textarea is the anchor because the caret cannot be measured directly.
   */
  const placeMentionMenu = (area: HTMLTextAreaElement) => {
    const anchor = mentionAnchor;
    if (!anchor) return;
    // The box is the anchor rather than the textarea: the textarea grows with the message, and a
    // menu anchored to a growing box drifts as it grows.
    // What scrolls is the menu inside, so the content height comes from there: the anchor's own
    // height is whatever its cap already made it, and measuring that is a menu that shrinks.

    const content = anchor.querySelector<HTMLElement>(".mention-menu");
    applyMenuPlacement(anchor, placeMenu(area, anchor, { gap: 10, content }));
  };

  const submit = () => {
    const value = text().trim();
    if (!value || !canSend()) return;
    setMention(null);
    // Resolved here, where the text and the file list meet: what the model reads is the user's
    // message with the files it points at described in the terms its own tools use.
    props.onSend(value, parseMentions(value, props.mentionTargets));
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
                <h1 class="visually-hidden">Explore a binary with Repi</h1>
                <p class="chat-greeting" aria-hidden="true">
                  <span
                    class="chat-greeting-cycle"
                    data-phase={greetingPhase()}
                    onTransitionEnd={(event) => {
                      if (event.propertyName === "opacity") finishGreetingExit();
                    }}
                  >
                    {greeting().lead} <em>{greeting().focus}</em>
                  </span>
                </p>
                <p class="chat-welcome-copy">
                  Drop a binary, then ask in plain language. Analysis stays on this device.
                </p>
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
              <Show when={mention() !== null}>
                <div ref={(node) => (mentionAnchor = node)} class="mention-anchor">
                  <MentionMenu
                    targets={mentionMatches()}
                    active={mentionIndex()}
                    onHover={setMentionIndex}
                    onPick={acceptMention}
                  />
                </div>
              </Show>
              <textarea
                class="composer-input"
                ref={(node) => (input = node)}
                rows={1}
                placeholder="Ask about a binary…"
                aria-label="Message"
                value={text()}
                onInput={(event) => {
                  setText(event.currentTarget.value);
                  updateMention(event.currentTarget);
                  grow();
                }}
                onClick={(event) => updateMention(event.currentTarget)}
                onBlur={() => setMention(null)}
                onKeyDown={(event) => {
                  // While the file menu is open it owns the keys a menu owns: arrows to choose,
                  // Enter or Tab to take the file, Escape to leave the word alone.
                  if (mention() !== null) {
                    const matches = mentionMatches();
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      if (matches.length > 0) {
                        const step = event.key === "ArrowDown" ? 1 : -1;
                        setMentionIndex((current) => (current + step + matches.length) % matches.length);
                      }
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      const chosen = matches[mentionIndex()];
                      if (chosen) acceptMention(chosen);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMention(null);
                      return;
                    }
                  }
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
                  <ThinkingSelector
                    levels={props.thinkingLevels}
                    value={props.thinkingLevel}
                    onSelect={props.onSelectThinkingLevel}
                  />
                  <Show when={props.modelLimits}>
                    {(limits) => <ContextMeter used={props.contextUsed} limits={limits()} />}
                  </Show>
                  <Show when={props.canCompact && !props.working}>
                    <button
                      class="composer-compact"
                      type="button"
                      onClick={props.onCompact}
                      title="Summarize the older part of this conversation to free room; recent messages are kept as they are."
                    >
                      Summarize
                    </button>
                  </Show>
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
          <Show when={empty()}>
            <div class="starter-prompts" aria-label="Things to ask">
              <For each={STARTER_PROMPTS}>
                {(prompt) => (
                  <button type="button" onClick={() => chooseStarter(prompt)}>
                    <span>{prompt}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 17L17 7M9 7h8v8" />
                    </svg>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
    </main>
  );
}
