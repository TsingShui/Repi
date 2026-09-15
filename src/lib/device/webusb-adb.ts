import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";

/** A browser-authorized Android USB device. Its id is meaningful only to this tab. */
export interface AndroidUsbDevice {
  readonly id: string;
  readonly name: string;
  readonly serial: string;
}

export type RootAccess = "available" | "unavailable";

/** Facts read after the user has approved both WebUSB and ADB authentication. */
export interface AndroidDeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly serial: string;
  readonly androidVersion: string;
  readonly abi: string;
  readonly build: string;
  readonly selinux: string;
  readonly root: RootAccess;
}

/** A live ADB session. Call close rather than reaching into Tango's transport. */
export interface AndroidDeviceConnection {
  readonly info: AndroidDeviceInfo;
  readonly disconnected: Promise<void>;
  close(): Promise<void>;
}

export interface WebUsbAdbConnector {
  /** Devices to which this origin already has WebUSB permission. */
  listAuthorized(): Promise<readonly AndroidUsbDevice[]>;
  /** Opens Chromium's device picker. This must be called directly from a user gesture. */
  requestDevice(): Promise<AndroidUsbDevice | null>;
  /** Authenticates with the selected device and returns a live ADB session. */
  connect(id: string): Promise<AndroidDeviceConnection>;
}

function candidateId(device: AdbDaemonWebUsbDevice, index: number): string {
  // ADB serials are normally stable. The index keeps devices with an empty serial distinct
  // for the lifetime of this page without persisting an identifier unnecessarily.
  return `${device.serial || device.name || "android"}:${index}`;
}

function candidate(device: AdbDaemonWebUsbDevice, index: number): AndroidUsbDevice {
  /*
   * `name` is the USB product string, and a phone is free to leave it empty, call itself
   * "Android", or answer with its serial — which then looks like a name in a list. The name
   * Android actually reports (`ro.product.manufacturer` + `ro.product.model`) only exists once
   * ADB is up, so until then the honest answer is a placeholder with the serial beside it,
   * not a serial wearing a name's clothes.
   */
  const product = (device.name ?? "").trim();
  const serial = (device.serial ?? "").trim();
  const named = product !== "" && product !== serial && !/^android$/i.test(product);
  return {
    id: candidateId(device, index),
    name: named ? product : "Android device",
    serial,
  };
}

async function shellText(adb: Adb, command: readonly string[]): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (shell?.isSupported) {
    const result = await shell.spawnWaitText(command);
    return result.exitCode === 0 ? result.stdout.trim() : "";
  }

  return (await adb.subprocess.noneProtocol.spawnWaitText(command)).trim();
}

async function deviceInfo(
  adb: Adb,
  device: AndroidUsbDevice,
): Promise<AndroidDeviceInfo> {
  const prop = async (key: string) => (await adb.getProp(key).catch(() => "")).trim();
  const [manufacturer, model, androidVersion, abi, build, selinux, rootIdentity] = await Promise.all([
    prop("ro.product.manufacturer"),
    prop("ro.product.model"),
    prop("ro.build.version.release"),
    prop("ro.product.cpu.abi"),
    prop("ro.build.display.id"),
    shellText(adb, ["getenforce"]).catch(() => "Unknown"),
    // This is deliberately the only root operation performed during connection. It lets
    // the UI say what capability is available without altering the device.
    shellText(adb, ["su", "-c", "id"]).catch(() => ""),
  ]);

  const product = [manufacturer, model].filter(Boolean).join(" ");
  return {
    id: device.id,
    name: product || device.name,
    serial: device.serial,
    androidVersion: androidVersion || "Unknown",
    abi: abi || "Unknown ABI",
    build: build || "Unknown build",
    selinux: selinux || "Unknown",
    root: rootIdentity.includes("uid=0") ? "available" : "unavailable",
  };
}

/**
 * Creates the one browser-facing ADB module used by Repi.
 *
 * Tango's USB claiming, ADB packet framing, RSA credential persistence, and shell
 * probing stay behind this interface. Callers only choose a device, connect it, and
 * receive facts plus a close operation.
 */
export function createWebUsbAdbConnector(): WebUsbAdbConnector | null {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) return null;

  const credentialStore = new AdbWebCredentialStore("Repi");
  const devices = new Map<string, AdbDaemonWebUsbDevice>();

  const remember = (found: readonly AdbDaemonWebUsbDevice[]): readonly AndroidUsbDevice[] => {
    devices.clear();
    return found.map((device, index) => {
      const item = candidate(device, index);
      devices.set(item.id, device);
      return item;
    });
  };

  const getDevice = async (id: string): Promise<AdbDaemonWebUsbDevice> => {
    const known = devices.get(id);
    if (known) return known;

    remember(await manager.getDevices());
    const refreshed = devices.get(id);
    if (!refreshed) throw new Error("This Android device is no longer available to Repi.");
    return refreshed;
  };

  return {
    listAuthorized: async () => remember(await manager.getDevices()),
    requestDevice: async () => {
      const selected = await manager.requestDevice();
      if (!selected) return null;
      const item = candidate(selected, devices.size);
      devices.set(item.id, selected);
      return item;
    },
    connect: async (id: string) => {
      const rawDevice = await getDevice(id);
      const usbConnection = await rawDevice.connect();
      let adb: Adb | undefined;
      try {
        const transport = await AdbDaemonTransport.authenticate({
          serial: rawDevice.serial,
          connection: usbConnection,
          credentialStore,
        });
        adb = new Adb(transport);
        const info = await deviceInfo(adb, {
          id,
          name: rawDevice.name || "Android device",
          serial: rawDevice.serial,
        });

        let closed = false;
        return {
          info,
          disconnected: adb.disconnected,
          close: async () => {
            if (closed) return;
            closed = true;
            await adb?.close();
          },
        };
      } catch (error) {
        await adb?.close().catch(() => undefined);
        // Authentication failures leave the connection open by design. Closing the raw
        // handle releases the USB interface for another connection attempt or desktop adb.
        await usbConnection.writable.close().catch(() => undefined);
        throw error;
      }
    },
  };
}
