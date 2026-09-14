import { For, Show } from "solid-js";
import { formatBytes } from "../../../lib/detect-format";
import type { SectionEntry, UnitAnalysis } from "../../../lib/analysis/types";
import { formatAddress, supports } from "../../../lib/analysis/types";

export interface MetaViewProps {
  readonly analysis: UnitAnalysis;
  readonly revision: number;
}

/**
 * Rows rendered before the list is truncated. A stripped production binary can
 * carry tens of thousands of imports, and a readout that stalls the page is worse
 * than one that says what it left out.
 */
const ROW_LIMIT = 400;

function SectionTable(props: { readonly sections: readonly SectionEntry[] }) {
  const visible = () => props.sections.slice(0, ROW_LIMIT);

  return (
    <Show
      when={props.sections.length > 0}
      fallback={<p class="meta-empty">None</p>}
    >
      <div class="meta-table" data-testid="meta-sections">
        <div class="meta-table-head" aria-hidden="true">
          <span>NAME</span>
          <span>ADDRESS</span>
          <span>SIZE</span>
          <span>FLAGS</span>
        </div>
        <For each={visible()}>
          {(section) => (
            <div class="meta-table-row">
              <span class="meta-cell-name">{section.name}</span>
              <span class="meta-cell-mono">{formatAddress(section.address)}</span>
              <span class="meta-cell-mono">{formatBytes(section.size)}</span>
              <span class="meta-cell-mono">{section.flags}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.sections.length > ROW_LIMIT}>
        <p class="meta-truncated">
          Showing {ROW_LIMIT} of {props.sections.length.toLocaleString()}.
        </p>
      </Show>
    </Show>
  );
}

/**
 * File-level readout.
 *
 * Imports, sections and format are kept on one page because they are read
 * together: spotting a call in the imports and scrolling up to check a section
 * size is a normal move, and nested tabs would interrupt it.
 */
export function MetaView(props: MetaViewProps) {
  const facts = () => props.analysis.facts();
  const sections = () => props.analysis.sections();

  return (
    <div class="view-meta" data-testid="meta-view">
      <section class="meta-section">
        <h2 class="meta-heading">FORMAT</h2>
        <dl class="meta-facts">
          <div class="meta-fact">
            <dt>FORMAT</dt>
            <dd data-testid="meta-format">{facts().format}</dd>
          </div>
          <div class="meta-fact">
            <dt>ARCHITECTURE</dt>
            <dd>{facts().architecture}</dd>
          </div>
          <div class="meta-fact">
            <dt>SIZE</dt>
            <dd>{formatBytes(facts().size)}</dd>
          </div>
          <div class="meta-fact">
            <dt>SHA-256</dt>
            <dd class="meta-hash" data-testid="meta-hash">
              {facts().hash}
            </dd>
          </div>
          <Show when={facts().workerMemory}>
            {(memory) => (
              <div class="meta-fact">
                <dt>WORKER MEMORY</dt>
                <dd>{memory()}</dd>
              </div>
            )}
          </Show>
        </dl>
      </section>

      {/*
        The heading goes with the table. A heading over "None" reads as a binary
        with no sections; the truth here is an engine that cannot list them.
      */}
      <Show when={supports(props.analysis, "sections")}>
        <section class="meta-section">
          <h2 class="meta-heading">SECTIONS</h2>
          <SectionTable sections={sections()} />
        </section>
      </Show>

    </div>
  );
}
