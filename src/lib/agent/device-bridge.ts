/**
 * The device, as the agent runtime sees it.
 *
 * An Android device is not a binary and not a file: it is a thing the user plugged in, that a
 * user gesture put in reach, and that can leave at any moment. The runtime needs exactly four
 * things from it — what it is, and the three verbs a host of anything has: run, take, put —
 * and it must not know how any of them is spelled on the wire, because that is Tango's ADB
 * transport and WebUSB's business.
 *
 * `describe` returns prose rather than fields on purpose: it is what the model reads in its
 * instructions, and the answer "no device" has to be as legible as the answer "a Pixel 8".
 */
export interface DeviceBridge {
  /** One line about the connected device, or null when there is none. */
  describe(): string | null;
  /** Runs one command on the device. `input` is written to its stdin, then closed. */
  shell(
    command: string,
    input?: string,
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
    readonly truncated: boolean;
    readonly timedOut: boolean;
  }>;
  /** Reads one file off the device. */
  pull(remote: string): Promise<Uint8Array>;
  /** Writes one file to the device. */
  push(remote: string, bytes: Uint8Array, permission?: number): Promise<void>;
}
