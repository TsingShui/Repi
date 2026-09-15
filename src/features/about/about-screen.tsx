import { createSignal, For, Show } from "solid-js";
import { BrandMark } from "../../components/brand-mark";
import { CREDITS, PROJECT } from "./credits";
import { StructureField } from "./structure-field";
import "./about-screen.css";

/** The command that installs the Pi package half of Repi. */
const QUICK_START = "pi install https://github.com/TsingShui/pi-re";

export interface AboutScreenProps {
  /** Back to the conversation, which is the home surface. */
  readonly onClose: () => void;
}

/**
 * What Repi is, and what it is made of.
 *
 * One page rather than two: the licence list used to live behind its own link, and it
 * is the same kind of page as this one — something read once, deliberately, by
 * somebody deciding whether to trust the thing. Two pages meant two designs for one
 * job and a link that had to be found first.
 */
export function AboutScreen(props: AboutScreenProps) {
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "selected">("idle");
  let commandNode: HTMLElement | undefined;

  /*
   * The install line is for the other half of Repi: the Pi package that carries the
   * toolchain, which is a different thing from this application. The command is on
   * screen and selectable either way, so a refused clipboard is not worth an error —
   * copying is the convenience, not the content.
   */
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(QUICK_START);
      setCopyState("copied");
    } catch {
      /*
       * The clipboard can refuse: it needs a secure context, a focused document and
       * either permission or a real user gesture. Doing nothing was the first version
       * of this and it reads as a broken button — the click lands, the label does not
       * change, and there is no way to tell whether it worked. The fallback selects
       * the command instead, so the platform's own copy gesture always has something
       * to act on.
       */
      const node = commandNode;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
        setCopyState("selected");
      }
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  };

  const copyLabel = () => {
    switch (copyState()) {
      case "copied":
        return "Copied";
      case "selected":
        return "Selected";
      default:
        return "Copy";
    }
  };

  return (
    <>
      {/*
        Decoration only now. It used to answer a file being accepted on this page; the
        page does not accept files any more, and the component's pulse has no caller.
      */}
      <StructureField />

      <header class="top-bar about-top-bar">
        <div class="top-bar-group">
          <button class="top-bar-back" type="button" onClick={props.onClose} aria-label="Back to home">
            <BrandMark />
          </button>
          <button class="top-bar-agent-back" type="button" onClick={props.onClose}>
            Back to Agent
          </button>
          <span class="top-bar-sep" aria-hidden="true">
            |
          </span>
          <span class="top-bar-title">About</span>
        </div>
      </header>

      <main class="about">
        <div class="about-column">
          <section class="about-hero">
            <h1 class="about-title">Your device is the edge.</h1>
            <p class="about-lede">
              Repi is an open-source reverse-engineering platform for the edge. Everything runs on
              your own machine, except the text sent to your own model.
            </p>
          </section>

          <section class="about-section">
            <h2 class="about-heading">The other half</h2>
            <p class="about-body">
              Repi runs in a browser, and a browser caps what it can be: performance and extensibility
              both have a ceiling here. pi-re is the same practice as a Pi Agent extension, running in
              your own agent with your own tools installed. Install it to work locally:
            </p>
            <div class="quick-start">
              <code class="quick-start-command" ref={(node) => (commandNode = node)}>
                {QUICK_START}
              </code>
              <button
                class="quick-start-copy"
                type="button"
                data-copy-state={copyState()}
                aria-live="polite"
                onClick={copyCommand}
              >
                {copyLabel()}
              </button>
            </div>
          </section>

          <section class="about-section" data-testid="credits">
            <h2 class="about-heading">What it is built on</h2>
            <p class="about-body">
              Repi is a thin layer over work other people did and maintain. Each project is listed with
              the terms it comes under, grouped by where it ends up.
            </p>

            <div class="credit" data-testid="credit-project" data-credit={PROJECT.name}>
              <div class="credit-head">
                <a class="credit-name" href={PROJECT.url} rel="noreferrer">
                  {PROJECT.name}
                </a>
                <span class="credit-license">{PROJECT.license}</span>
              </div>
              <p class="credit-note">The application itself: it reads a binary and reports what it is.</p>
            </div>

            <For each={CREDITS}>
              {(credit) => (
                <div class="credit" data-testid="credit" data-credit={credit.name}>
                  <div class="credit-head">
                    <a class="credit-name" href={credit.url} rel="noreferrer">
                      {credit.name}
                    </a>
                    <span class="credit-license">{credit.license}</span>
                  </div>
                  <p class="credit-note">
                    {credit.note}
                    <Show when={credit.derivedFrom}>
                      {(from) => (
                        <>
                          {" "}
                          A rewrite of{" "}
                          <a href={from().url} rel="noreferrer">
                            {from().name}
                          </a>
                          .
                        </>
                      )}
                    </Show>
                  </p>
                </div>
              )}
            </For>

          </section>
        </div>
      </main>
    </>
  );
}
