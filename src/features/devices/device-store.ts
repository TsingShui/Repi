import { createSignal, onCleanup } from "solid-js";
import {
  createWebUsbAdbConnector,
  type AndroidDeviceConnection,
  type AndroidDeviceInfo,
  type AndroidUsbDevice,
} from "../../lib/device/webusb-adb";
import type { DeviceBridge } from "../../lib/agent/device-bridge";

export type DeviceStatus = "unsupported" | "idle" | "connecting" | "connected" | "error";

export interface DeviceSidebarState {
  readonly status: DeviceStatus;
  readonly name: string | null;
}

function messageFor(error: unknown): string {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  // Tango's DeviceBusyError intentionally inherits Error's default name, so match
  // its stable message as well as the named form for future versions.
  if (name === "DeviceBusyError" || /already in used by another program/i.test(message)) {
    return "The phone's ADB USB interface is already in use. Disconnect desktop adb and try again.";
  }
  if (name === "NetworkError") {
    return "The USB connection was interrupted. Reconnect the phone and try again.";
  }
  if (name === "SecurityError") {
    return "WebUSB needs a secure origin: HTTPS or localhost.";
  }
  if (message) return message;
  return "Repi could not connect to this Android device.";
}

/**
 * The UI-facing device module. It owns a single direct WebUSB ADB session and
 * collapses transport details into a small state surface for the sidebar/dialog.
 */
export function createDeviceStore() {
  const connector = createWebUsbAdbConnector();
  const [status, setStatus] = createSignal<DeviceStatus>(connector ? "idle" : "unsupported");
  /**
   * What to say when nothing happened.
   *
   * Closing Chrome's USB picker, and opening it when no device advertises an ADB interface,
   * are the same event from the page's side — the library reports both as "no device" — and
   * both used to leave the dialog exactly as it was. A click that changes nothing is
   * indistinguishable from a broken button, so the checklist is said out loud.
   */
  const [notice, setNotice] = createSignal<string | null>(null);
  const [available, setAvailable] = createSignal<readonly AndroidUsbDevice[]>([]);
  const [device, setDevice] = createSignal<AndroidDeviceInfo | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let connection: AndroidDeviceConnection | undefined;
  let disposed = false;

  const refresh = async () => {
    if (!connector) return;
    try {
      const found = await connector.listAuthorized();
      if (!disposed) setAvailable(found);
    } catch (caught) {
      if (!disposed) setError(messageFor(caught));
    }
  };

  const clearConnection = () => {
    connection = undefined;
    if (!disposed) {
      setDevice(null);
      setStatus("idle");
    }
  };

  const watchConnection = (next: AndroidDeviceConnection) => {
    void next.disconnected.then(() => {
      if (connection === next) clearConnection();
    }).catch(() => {
      if (connection === next) clearConnection();
    });
  };

  const connect = async (id: string) => {
    if (!connector || status() === "connecting") return;
    setStatus("connecting");
    setError(null);

    try {
      const next = await connector.connect(id);
      if (disposed) {
        await next.close();
        return;
      }
      await connection?.close().catch(() => undefined);
      connection = next;
      setDevice(next.info);
      setStatus("connected");
      watchConnection(next);
      void refresh();
    } catch (caught) {
      if (!disposed) {
        setStatus("error");
        setError(messageFor(caught));
      }
    }
  };

  const requestAndConnect = async () => {
    if (!connector || status() === "connecting") return;
    setStatus("connecting");
    setError(null);
    setNotice(null);

    try {
      // No await happens before this request. Chromium requires the WebUSB picker to
      // originate in the click that called this function.
      const selected = await connector.requestDevice();
      if (!selected) {
        if (!disposed) {
          setStatus("idle");
          setNotice(
            "No device was chosen. If the list was empty, the phone is not offering an ADB " +
              "interface yet: turn on USB debugging, set the USB mode to file transfer or PTP " +
              "(not “charging only”), and keep the phone plugged into the machine running this " +
              "browser — a device handed to WSL or to usbipd is not visible to a Windows Chrome.",
          );
        }
        return;
      }
      // `connect` guards against a second click while connecting. The picker itself
      // put us in that state, so reset before continuing with the selected device.
      if (!disposed) {
        setStatus("idle");
        await connect(selected.id);
      }
    } catch (caught) {
      if (!disposed) {
        setStatus("error");
        setError(messageFor(caught));
      }
    }
  };

  const disconnect = async () => {
    const current = connection;
    clearConnection();
    await current?.close().catch(() => undefined);
  };

  const sidebar = (): DeviceSidebarState => ({
    status: status(),
    name: device()?.name ?? null,
  });

  /**
   * The device, as the agent sees it.
   *
   * The agent is not a second client of the device: it drives the same one session the dialog
   * does, through the same connection object, so a command it runs and a fact the dialog shows
   * can never disagree about which phone is attached. What differs is only the shape — the
   * dialog reads state, the agent asks for work — and the two failure modes worth naming:
   * no device at all, and a device that went away mid-session.
   */
  const requireConnection = (): AndroidDeviceConnection => {
    if (!connection) {
      throw new Error(
        "No Android device is connected. Connecting one needs a person: it is Chrome's USB " +
          "picker, and it only opens from a click in the app. Ask the user to attach the device " +
          "from the sidebar, then try again.",
      );
    }
    return connection;
  };

  const bridge: DeviceBridge = {
    describe(): string | null {
      const info = device();
      if (!info) return null;
      return (
        `${info.name} (${info.serial}) — Android ${info.androidVersion}, ${info.abi}, ` +
        `build ${info.build}, SELinux ${info.selinux}, root ${info.root}`
      );
    },
    shell: (command, input) => requireConnection().shell(command, input ? { input } : undefined),
    pull: (remote) => requireConnection().pull(remote),
    push: (remote, bytes, permission) => requireConnection().push(remote, bytes, permission),
  };

  void refresh();
  onCleanup(() => {
    disposed = true;
    void connection?.close();
  });

  return {
    status,
    available,
    device,
    error,
    notice,
    sidebar,
    refresh,
    connect,
    requestAndConnect,
    bridge,
    disconnect,
  };
}
