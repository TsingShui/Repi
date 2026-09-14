import { createSignal, Show } from "solid-js";
import { BrandMark } from "../../components/brand-mark";
import { StructureField, type StructureFieldApi } from "./structure-field";
import "./home-screen.css";

/** The command that installs the Pi package half of Repi. */
const QUICK_START = "pi install https://github.com/TsingShui/Repi";

export interface HomeScreenProps {
  /** A file was chosen. The application decides whether it can be opened. */
  readonly onPick: (file: File | undefined) => void;
  /** A file is being read right now, so the button says so. */
  readonly busy: boolean;
  /** Why the last file could not be opened. Null when there is nothing to say. */
  readonly notice: string | null;
  /** A file is being carried over the window, so the drop block should say so. */
  readonly dropActive: boolean;
}

export function HomeScreen(props: HomeScreenProps) {
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "selected">("idle");
  let commandNode: HTMLElement | undefined;

  let field: StructureFieldApi | undefined;

  /*
   * The drop is handled by the application, because it is accepted over the
   * workspace too. The field only needs to answer the file that actually arrived,
   * so it is pulsed from the picker here rather than from a drag state it would
   * have to watch.
   */
  /** The same control the drop block falls back to, so neither block is a dead end. */
  const openPicker = () => {
    document.querySelector<HTMLInputElement>(".file-input")?.click();
  };

  const pick = (file: File | undefined) => {
    if (!file) return;
    field?.pulse();
    props.onPick(file);
  };

  /*
   * The install line is for the other half of Repi: the Pi package that carries
   * the toolchain, which is a different thing from this page's workspace. The
   * command is on screen and selectable either way, so a refused clipboard is
   * not worth an error — copying is the convenience, not the content.
   */
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(QUICK_START);
      setCopyState("copied");
    } catch {
      /*
       * The clipboard can refuse: it needs a secure context, a focused document
       * and either permission or a real user gesture. Doing nothing was the first
       * version of this and it reads as a broken button — the click lands, the
       * label does not change, and there is no way to tell whether it worked. The
       * fallback selects the command instead, so the platform's own copy gesture
       * always has something to act on.
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
      <StructureField onReady={(api) => (field = api)} />

      <header class="top-bar">
        <div class="top-bar-group">
          <BrandMark />
          <span class="brand-name">Repi</span>
        </div>
        <nav class="top-bar-links" aria-label="About this project">
          <a class="top-bar-link" href="https://github.com/TsingShui/Repi" rel="noreferrer">
            GitHub
          </a>
          <a class="top-bar-link" href="https://tsingshui.art/about" rel="noreferrer">
            About<span class="top-bar-link-arrow" aria-hidden="true">↗</span>
          </a>
          <a class="top-bar-link" href="#/licenses" data-testid="licenses-link">
            Licenses
          </a>
        </nav>
      </header>

      <main class="home">
        <section class="home-hero">
          <p class="eyebrow">EDGE-NATIVE REVERSE ENGINEERING</p>
          <h1 class="hero-title">
            Your device
            <br />
            is the edge.
          </h1>
          <p class="hero-copy">
            The reverse-engineering command line, rebuilt for the browser. Nothing is uploaded: the
            analysis runs on the machine in your hands. That is the shift this era makes possible — the
            tooling no longer needs a datacentre, only the device you are already holding.
          </p>

          <div class="hero-actions">
            {/*
              Two ways in, shown as two blocks. Tapping the second also opens the
              picker: you cannot tap to drag, and a block that looks like a button
              and answers nothing is worse than one that does the obvious thing.
              The drag itself is handled by the application, for the whole window.
            */}
            <label class="entry-block is-primary" aria-label="Open a local file">
              {/*
                No `accept` filter on purpose: stripped binaries often carry no
                extension, and iPadOS hides files that fail a type filter.
              */}
              <input
                class="file-input"
                type="file"
                onChange={(event) => {
                  const picked = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  pick(picked);
                }}
              />
              <span class="entry-block-label">{props.busy ? "Reading…" : "Open"}</span>
            </label>

            <button
              class="entry-block is-secondary"
              type="button"
              data-testid="drop-block"
              data-drop-active={props.dropActive ? "true" : "false"}
              aria-label="Drop a file here, or open the file picker"
              onClick={() => openPicker()}
            >
              <span class="entry-block-label">Drop file here</span>
            </button>
          </div>

          <span class="format-list">ELF · PE · MACH-O · APK · DEX</span>

          {/*
            Only refusals are reported here. A file Repi can open goes straight to
            the workspace — showing what was recognised first made opening a file
            feel like two steps, and the workspace already opens on that readout.
          */}
          <Show when={props.notice}>
            {(message) => (
              <p class="home-notice" role="status">
                {message()}
              </p>
            )}
          </Show>

          <div class="quick-start">
            <p class="quick-start-lead">Want more? Try the full Extension version</p>
            <div class="quick-start-row">
              <span class="quick-start-label">Quick start</span>
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
          </div>
        </section>
      </main>

      <p class="visually-hidden" aria-live="polite">
        {props.busy ? "Reading the file on this device." : (props.notice ?? "")}
      </p>
    </>
  );
}
