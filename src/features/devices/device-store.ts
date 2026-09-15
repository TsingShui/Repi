import { createSignal, onCleanup } from "solid-js";
import {
  createWebUsbAdbConnector,
  type AndroidDeviceConnection,
  type AndroidDeviceInfo,
  type AndroidUsbDevice,
} from "../../lib/device/webusb-adb";

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

    try {
      // No await happens before this request. Chromium requires the WebUSB picker to
      // originate in the click that called this function.
      const selected = await connector.requestDevice();
      if (!selected) {
        if (!disposed) setStatus("idle");
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
    sidebar,
    refresh,
    connect,
    requestAndConnect,
    disconnect,
  };
}
