import { Show } from "solid-js";

export interface ProgressBarProps {
  readonly active: boolean;
  /** A real fraction in [0, 1], or null when the engine cannot report one. */
  readonly fraction: number | null;
}

/**
 * The one progress indicator for every analysis stage.
 *
 * It is an absolute overlay two pixels tall, so it never moves anything on the
 * page. When the engine reports a real fraction the bar shows it; when it cannot,
 * the bar is indeterminate. A percentage that creeps toward 90% on a timer is
 * never shown: slow is honest, fabricated progress is not.
 */
export function ProgressBar(props: ProgressBarProps) {
  return (
    <Show when={props.active}>
      <div
        class="progress-overlay"
        data-testid="progress"
        data-determinate={props.fraction === null ? "false" : "true"}
        role="progressbar"
        aria-label="Analysis progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={props.fraction === null ? undefined : Math.round(props.fraction * 100)}
      >
        <div
          class="progress-fill"
          style={props.fraction === null ? undefined : `width: ${(props.fraction * 100).toFixed(1)}%`}
        />
      </div>
    </Show>
  );
}
