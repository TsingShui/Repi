import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
// The sync service takes this package's `ReadableStream`, which is the platform one with
// statics: `from` is how a byte array becomes a stream the pusher can pipe.
import { ReadableStream as AdbReadableStream } from "@yume-chan/stream-extra";
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

/** What one command on the device said. */
export interface AndroidShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  /** A cap was reached, so the text is a prefix and the command may still have been running. */
  readonly truncated: boolean;
  /** The command was still running when its time was up and was killed. */
  readonly timedOut: boolean;
}

/**
 * How much of a command's output is kept.
 *
 * A shell is the one interface where the device, not the host, decides how much text comes
 * back: `pm list packages` is a few KB, `cat` on a partition is megabytes, and a command that
 * loops forever is unbounded. The cap is the host's answer — it keeps reading until this much
 * and then stops, rather than trusting the command to be reasonable.
 */
const SHELL_OUTPUT_LIMIT = 256 << 10;
/** A command that has not finished by now is killed; the device is not the host's to block. */
const SHELL_TIMEOUT_MS = 120_000;
/** The largest file the sync service is allowed to move in one call. */
const FILE_LIMIT = 512 << 20;

/** A live ADB session. Call close rather than reaching into Tango's transport. */
export interface AndroidDeviceConnection {
  readonly info: AndroidDeviceInfo;
  readonly disconnected: Promise<void>;
  /**
   * Runs one command and waits for it.
   *
   * `input` is written to the command's stdin and then closed, which is what makes programs
   * that read a script from stdin usable — Frida's injector is the reason this exists: it
   * takes its script as `-s -`, so a script never has to be written to the device's disk.
   * The legacy (non-shell-protocol) transport has no stdin and no exit code, and says so by
   * reporting 0 for a command whose output arrived.
   */
  shell(command: string, options?: { readonly input?: string }): Promise<AndroidShellResult>;
  /** Reads one file off the device through the sync service. */
  pull(remote: string): Promise<Uint8Array>;
  /** Writes one file to the device through the sync service. */
  push(remote: string, bytes: Uint8Array, permission?: number): Promise<void>;
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

/** Reads a stream to its end, stopping at `limit` bytes. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** Runs one command on the device, streaming `input` into it and capping what comes back. */
async function shellCommand(
  adb: Adb,
  command: string,
  options: { readonly input?: string } | undefined,
): Promise<AndroidShellResult> {
  const shell = adb.subprocess.shellProtocol;
  const input = options?.input;

  // Without the shell protocol there is no stdin, no exit code and no separate stderr. A
  // command that needs stdin cannot be run at all, which is a fact worth reporting rather
  // than silently sending something the device will ignore.
  if (!shell) {
    if (input !== undefined && input !== "") {
      throw new Error(
        "This device's adb transport has no stdin channel, so a command cannot be given a " +
          "script to read. Run it with the script written to a file instead.",
      );
    }
    const result = await adb.subprocess.noneProtocol.spawnWaitText(command);
    return { stdout: result.trim(), stderr: "", code: 0, truncated: false, timedOut: false };
  }

  const process = await shell.spawn(command);
  const decoder = new TextDecoder();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void process.kill();
  }, SHELL_TIMEOUT_MS);

  const write = (async () => {
    const writer = process.stdin.getWriter();
    try {
      if (input !== undefined && input !== "") await writer.write(new TextEncoder().encode(input));
    } catch {
      // A command that exits without reading stdin closes the pipe under us; that is its
      // right, and the output is what matters.
    } finally {
      await writer.close().catch(() => undefined);
    }
  })();

  try {
    const [out, err] = await Promise.all([
      collect(process.stdout as ReadableStream<Uint8Array>, SHELL_OUTPUT_LIMIT),
      collect(process.stderr as ReadableStream<Uint8Array>, SHELL_OUTPUT_LIMIT),
    ]);
    await write;
    const code = await process.exited;
    return {
      stdout: decoder.decode(out.bytes),
      stderr: decoder.decode(err.bytes),
      code,
      truncated: out.truncated || err.truncated,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
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
        const open = () => {
          if (closed) throw new Error("This Android device is no longer connected.");
          return adb as Adb;
        };
        return {
          info,
          disconnected: adb.disconnected,
          shell: (command, options) => shellCommand(open(), command, options),
          pull: async (remote) => {
            const sync = await open().sync();
            try {
              const { bytes, truncated } = await collect(
                sync.read(remote) as ReadableStream<Uint8Array>,
                FILE_LIMIT,
              );
              if (truncated) {
                throw new Error(`${remote} is larger than the ${FILE_LIMIT >> 20} MB limit.`);
              }
              return bytes;
            } finally {
              await sync.dispose().catch(() => undefined);
            }
          },
          push: async (remote, bytes, permission) => {
            const sync = await open().sync();
            try {
              await sync.write({
                filename: remote,
                file: AdbReadableStream.from(
                  (function* () {
                    yield bytes;
                  })(),
                ),
                ...(permission === undefined ? {} : { permission }),
              });
            } finally {
              await sync.dispose().catch(() => undefined);
            }
          },
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
