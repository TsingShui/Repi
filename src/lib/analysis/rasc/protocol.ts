/**
 * What the page and the Rasc worker say to each other.
 *
 * Kept apart from both sides so the driver can import the shapes without
 * importing the Worker — a Worker that the page pulls in as a module would run
 * its setup on the main thread, which is the one thing this file exists to
 * prevent.
 */

export interface RascLoadRequest {
  readonly type: "load";
  readonly file: File;
  /** Where `npm run build:rasc` put the module. Absolute, same origin. */
  readonly wasmUrl: string;
  /** Check seam: hold each command's answer this long, so a cancel can land. */
  readonly delayMs: number;
}

export interface RascRunRequest {
  readonly type: "run";
  readonly id: number;
  /** The command line, in the CLI's own words, minus `argv[0]`. */
  readonly args: readonly string[];
}

export type RascRequest = RascLoadRequest | RascRunRequest;

export interface RascReadyResponse {
  readonly type: "ready";
  readonly size: number;
}

export interface RascChunkResponse {
  readonly type: "chunk";
  readonly id: number;
  readonly bytes: Uint8Array;
}

export interface RascProgressResponse {
  readonly type: "progress";
  readonly id: number;
  /** Entries walked, out of the total the engine knew before it started. */
  readonly done: number;
  readonly total: number;
}

export interface RascDoneResponse {
  readonly type: "done";
  readonly id: number;
  readonly code: number;
  readonly memoryBytes: number;
  /** Range reads the core asked for, and how many reached the file. Host cost. */
  readonly reads: number;
  readonly fetches: number;
}

export interface RascFailedResponse {
  readonly type: "failed";
  readonly id: number | null;
  readonly message: string;
}

export type RascResponse =
  | RascReadyResponse
  | RascChunkResponse
  | RascProgressResponse
  | RascDoneResponse
  | RascFailedResponse;
