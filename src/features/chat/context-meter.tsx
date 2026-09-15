/**
 * How full the conversation is, where the model is chosen.
 *
 * It sits beside the model and the thinking level because it is a fact about that pair: the same
 * conversation is a third of the way through one model's window and all of another's. The bar is
 * the shape of the answer — filling up — and the numbers are the answer itself, so both are
 * shown; a bar alone would make "12K of 128K" and "12K of 1M" look the same.
 *
 * A window this app only assumed is marked as assumed. A number read from a catalog and a number
 * written by hand in the code should not look identical in a display that exists to be trusted.
 */
import { Show } from "solid-js";
import { contextPercent, contextSentence, formatTokens } from "./context-usage";
import "./context-meter.css";
import type { ModelLimits } from "../models/model-facts";

export interface ContextMeterProps {
  readonly used: number;
  readonly limits: ModelLimits;
}

function level(percent: number): string {
  if (percent >= 90) return "danger";
  if (percent >= 70) return "working";
  return "local";
}

export function ContextMeter(props: ContextMeterProps) {
  const percent = () => contextPercent(props.used, props.limits.contextWindow);
  const sentence = () =>
    contextSentence(props.used, props.limits.contextWindow, props.limits.assumed);

  return (
    <div class="context-meter" data-level={level(percent())} title={sentence()} aria-label={sentence()}>
      <span class="context-meter-track" aria-hidden="true">
        <span class="context-meter-fill" style={{ width: `${percent()}%` }} />
      </span>
      <span class="context-meter-value" aria-hidden="true">
        {formatTokens(props.used)}
        <span class="context-meter-separator">/</span>
        <Show when={props.limits.assumed} fallback={formatTokens(props.limits.contextWindow)}>
          ~{formatTokens(props.limits.contextWindow)}
        </Show>
      </span>
    </div>
  );
}
