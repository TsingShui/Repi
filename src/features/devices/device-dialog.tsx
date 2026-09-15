import { createEffect, For, Show } from "solid-js";
import type { AndroidDeviceInfo, AndroidUsbDevice } from "../../lib/device/webusb-adb";
import type { DeviceStatus } from "./device-store";
import "./device-dialog.css";

export interface DeviceDialogProps {
  readonly open: boolean;
  readonly status: DeviceStatus;
  readonly available: readonly AndroidUsbDevice[];
  readonly device: AndroidDeviceInfo | null;
  readonly error: string | null;
  /** What to say when the picker was closed or came up empty. Not a failure: a fact. */
  readonly notice: string | null;
  readonly onClose: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onConnect: (id: string) => Promise<void>;
  readonly onRequestDevice: () => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
}

function rootLabel(device: AndroidDeviceInfo): string {
  return device.root === "available" ? "Root access confirmed" : "Root access not granted";
}

export function DeviceDialog(props: DeviceDialogProps) {
  let dialog: HTMLDialogElement | undefined;
  const busy = () => props.status === "connecting";

  createEffect(
    () => props.open,
    (open) => {
      if (!dialog) return;
      if (open && !dialog.open) dialog.showModal();
      else if (!open && dialog.open) dialog.close();
    },
  );

  const close = () => props.onClose();

  return (
    <dialog
      class="device-dialog"
      ref={(node) => (dialog = node)}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={() => {
        if (props.open) props.onClose();
      }}
    >
      <div class="device-dialog-head">
        <div>
          <h2>Android device</h2>
          <p>Direct, local ADB over WebUSB.</p>
        </div>
        <button type="button" class="device-dialog-close" aria-label="Close" onClick={close}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      <Show
        when={props.status !== "unsupported"}
        fallback={
          <section class="device-notice" data-kind="warning">
            <strong>WebUSB is unavailable</strong>
            <p>Use a Chromium browser on HTTPS or localhost, then enable USB debugging on the phone.</p>
          </section>
        }
      >
        <Show when={props.device}>
          {(connected) => (
            <section class="device-connected" aria-label="Connected Android device">
              <div class="device-connected-head">
                <span class="device-glyph" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M10 6h4M11.5 18h1" /></svg>
                </span>
                <div>
                  <strong>{connected().name}</strong>
                  <span>Connected over WebUSB</span>
                </div>
                <span class="device-live-dot" aria-label="Connected" />
              </div>

              <dl class="device-facts">
                <div><dt>Android</dt><dd>{connected().androidVersion}</dd></div>
                <div><dt>ABI</dt><dd>{connected().abi}</dd></div>
                <div><dt>SELinux</dt><dd>{connected().selinux}</dd></div>
                <div><dt>Root</dt><dd data-root={connected().root}>{rootLabel(connected())}</dd></div>
              </dl>

              <p class="device-build">{connected().build}</p>
              <button
                class="device-disconnect"
                type="button"
                disabled={busy()}
                onClick={() => void props.onDisconnect()}
              >
                Disconnect
              </button>
            </section>
          )}
        </Show>

        <Show when={!props.device}>
          <section class="device-connect-section">
            <Show when={props.available.length > 0}>
              <div class="device-section-heading">
                <span>Previously approved</span>
                <button type="button" disabled={busy()} onClick={() => void props.onRefresh()}>Refresh</button>
              </div>
              <div class="device-known-list">
                <For each={props.available}>
                  {(available) => (
                    <button
                      type="button"
                      class="device-known"
                      disabled={busy()}
                      onClick={() => void props.onConnect(available.id)}
                    >
                      <span class="device-known-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M10 6h4M11.5 18h1" /></svg>
                      </span>
                      <span>{available.name}</span>
                      <small>{available.serial || "USB debugging"}</small>
                      <svg class="device-known-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <button
              class="device-request"
              type="button"
              disabled={busy()}
              onClick={() => void props.onRequestDevice()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M10 6h4M12 10v5M9.5 12.5h5" /></svg>
              {busy() ? "Waiting for device…" : "Connect an Android device"}
            </button>

            <Show when={props.status === "connecting"}>
              <p class="device-waiting" role="status">
                Waiting for the picker, then for the phone: Android will ask you to
                <strong> Allow USB debugging</strong> — accept it on the device.
              </p>
            </Show>

            <Show when={props.notice}>
              {(message) => (
                <p class="device-notice-line" role="status">
                  {message()}
                </p>
              )}
            </Show>

            <p class="device-help">
              Repi opens Chrome’s USB picker, then Android asks you to authorize its ADB key. A direct
              USB connection may require desktop <code>adb</code> to release the phone first, and the
              picker only lists a phone that is offering an ADB interface.
            </p>
          </section>
        </Show>

        <Show when={props.error}>{(message) => <p class="device-error" role="alert">{message()}</p>}</Show>
        <p class="device-privacy">
          Device details and ADB credentials stay in this browser. Repi only runs a read-only root check
          (<code>su -c id</code>) while connecting.
        </p>
      </Show>
    </dialog>
  );
}
