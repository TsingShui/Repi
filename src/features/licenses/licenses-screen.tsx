import { For, Show } from "solid-js";
import { BrandMark } from "../../components/brand-mark";
import { CREDITS, PROJECT, SCOPE_LABELS, type CreditScope } from "./credits";
import "./licenses-screen.css";

export interface LicensesScreenProps {
  readonly onClose: () => void;
}

/** The order the page reads in: what you get, then what shows it, then what built it. */
const SCOPE_ORDER: readonly CreditScope[] = ["engine", "upstream", "page", "build"];

/**
 * What Repi is made of, and on whose terms.
 *
 * A page rather than a dialog, because it is the kind of thing people arrive at
 * deliberately — from a licence question, or from wanting to check a claim about
 * where a binary goes. It is reachable from the home screen and needs no engine
 * to be installed, since the question is asked just as often before as after.
 */
export function LicensesScreen(props: LicensesScreenProps) {
  return (
    <>
      <header class="top-bar">
        <div class="top-bar-group">
          <button class="top-bar-back" type="button" onClick={props.onClose} aria-label="Back to home">
            <BrandMark />
          </button>
          <span class="brand-name">Repi</span>
          <span class="top-bar-sep" aria-hidden="true">
            |
          </span>
          <span class="top-bar-title">Licenses</span>
        </div>
      </header>

      <main class="licenses" data-testid="licenses">
        <div class="licenses-column">
          <p class="eyebrow">LICENSES</p>
          <h1 class="licenses-title">Built on other people's work.</h1>
          <p class="licenses-intro">
            Repi is a thin layer over decompilers that other people wrote and maintain. What
            follows is what it uses, under which terms, and where each one ends up.
          </p>

          <section class="licenses-project">
            <h2 class="licenses-heading">This project</h2>
            <div class="credit" data-testid="credit-project">
              <div class="credit-head">
                <a class="credit-name" href={PROJECT.url} rel="noreferrer">
                  {PROJECT.name}
                </a>
                <span class="credit-license">{PROJECT.license}</span>
              </div>
              <p class="credit-note">
                The application itself, under the same licence as every engine behind it.
              </p>
            </div>
          </section>

          <For each={SCOPE_ORDER}>
            {(scope) => (
              <Show when={CREDITS.some((credit) => credit.scope === scope)}>
                <section class="licenses-section">
                  <h2 class="licenses-heading">{SCOPE_LABELS[scope]}</h2>
                  <For each={CREDITS.filter((credit) => credit.scope === scope)}>
                    {(credit) => (
                      <div class="credit" data-testid="credit" data-credit={credit.name}>
                        <div class="credit-head">
                          <a class="credit-name" href={credit.url} rel="noreferrer">
                            {credit.name}
                          </a>
                          <span class="credit-license">{credit.license}</span>
                        </div>
                        <p class="credit-note">{credit.note}</p>
                      </div>
                    )}
                  </For>
                </section>
              </Show>
            )}
          </For>

          <section class="licenses-section">
            <h2 class="licenses-heading">Full licence texts</h2>
            <p class="licenses-body">
              Each engine's <code>LICENSE</code> and <code>NOTICE</code> travel with its artifact — Kuna's
              are copied next to the WebAssembly when it is built, as
              <code>/kuna/KUNA-LICENSE</code> and <code>/kuna/KUNA-NOTICE</code>, and Rasc's are
              copied beside its module the same way. Repi's own is served at <code>/LICENSE</code> and
              <code>/NOTICE</code> alongside this page, because serving it is distributing it. The
              JavaScript packages carry their licence files inside their published packages.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
