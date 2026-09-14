/// <reference lib="webworker" />

/**
 * The Rasc engine, in a Worker.
 *
 * Rasc's wasm build has no filesystem. It asks the host for the exact byte ranges
 * it needs, synchronously, so the host has to be a Worker: only `FileReaderSync`
 * can read a `Blob` without awaiting, and the wasm import cannot await. The page
 * posts the user's `File` once and the engine is bound to it for the life of the
 * Worker.
 *

 * This Worker is also the interrupt primitive. A run is one call into WebAssembly
 * that returns when it is finished; there is no message the guest could read
 * while it is working, so cancelling is `Worker.terminate()` and a clean Worker,
 * which the driver does. That is why nothing here holds state the page needs back.
 */

import { Rasc, withReadAhead, type RascByteSource, type RascInstance } from "../../../vendor/rasc/rasc.mjs";
import type { RascRequest, RascResponse } from "./protocol";

/**
 * Per-entry inflation ceiling, in bytes.
 *
 * Rasc's own default is 256 MiB, which is a desktop's answer. Under wasm a failed
 * allocation does not raise — it kills the instance, and the user gets nothing at
 * all instead of a sentence — so a browser tab asks for less. Real DEX entries
 * inflate to tens of MiB (the largest in Rasc's 343 MiB sample APK is 11.4 MiB),
 * so this is still an order of magnitude above anything legitimate.
 */
const MAX_INFLATED_ENTRY = 128 << 20;

/**
 * A raw `Blob.slice` read is a synchronous trip to the file backend, measured at
 * roughly 190 us. The parser asks for tens of thousands of tiny ranges, so the
 * window is what turns an 18-second command into a fast one.
 */
const READ_AHEAD_WINDOW = 4 << 20;

let engine: RascInstance | null = null;
/** Check seam, from `?rascDelay`. Zero in the application. */
let delayMs = 0;

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function post(message: RascResponse, transfer: Transferable[] = []): void {
  (self as unknown as { postMessage(message: RascResponse, transfer: Transferable[]): void }).postMessage(
    message,
    transfer,
  );
}

/** A synchronous byte source over the user's file, windowed. */
function blobSource(blob: Blob): RascByteSource {
  const reader = new FileReaderSync();
  return withReadAhead(
    {
      size: blob.size,
      read(offset, length, into) {
        const bytes = new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length)));
        into.set(bytes);
        return bytes.length;
      },
    },
    READ_AHEAD_WINDOW,
  );
}

function describe(error: unknown): string {
  if (error instanceof WebAssembly.RuntimeError) {
    // A trap says nothing about why. The guest's panic hook has already written
    // `PANIC: …` to the payload, and the driver prefers that when it is there.
    return `The engine trapped: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

self.onmessage = async (event: MessageEvent<RascRequest>) => {
  const request = event.data;

  try {
    if (request.type === "load") {
      delayMs = request.delayMs;
      await sleep(delayMs);
      const response = await fetch(request.wasmUrl);
      if (!response.ok) throw new Error(`The engine was not found at ${request.wasmUrl}.`);
      const wasm = await response.arrayBuffer();

      engine = await Rasc.load({
        wasm,
        source: blobSource(request.file),
        maxInflatedEntry: MAX_INFLATED_ENTRY,
        onDiagnostic: (bytes) => {
          // Only `--debug` writes here, and the adapter never passes it, so this
          // exists so a diagnostic is never silently dropped.
          console.warn(new TextDecoder().decode(bytes).trimEnd());
        },
      });
      post({ type: "ready", size: engine.archiveLength });
      return;
    }

    if (engine === null) throw new Error("No archive is loaded.");
    await sleep(delayMs);
    const { code, reads, fetches } = engine.run(request.args, {
      onOutput: (bytes) => post({ type: "chunk", id: request.id, bytes }, [bytes.buffer]),
      // Posted as it arrives: the page is a separate thread whose event loop is free
      // while this one is inside WebAssembly, so the message does not wait for the call
      // to return, and the overlay gets a fraction while there is still work to do.
      onProgress: (done, total) => post({ type: "progress", id: request.id, done, total }),
    });
    post({
      type: "done",
      id: request.id,
      code,
      memoryBytes: engine.wasmMemoryBytes,
      reads,
      fetches,
    });
  } catch (error) {
    post({
      type: "failed",
      id: request.type === "run" ? request.id : null,
      message: describe(error),
    });
  }
};
