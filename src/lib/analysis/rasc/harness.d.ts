/**
 * Types for Rasc's vendored host glue.
 *
 * `src/vendor/rasc/rasc.mjs` is plain JavaScript copied verbatim from a Rasc
 * checkout, so it ships no declarations and is rewritten wholesale on every
 * refresh. These live here, in Repi's own tree, for exactly that reason: anything
 * placed beside the vendored file would be deleted by the next `npm run build:rasc`.
 *
 * Only the surface Repi uses is declared. A wider copy would be a second
 * description of Rasc that nobody maintains.
 */

declare module "*/vendor/rasc/rasc.mjs" {
  export interface RascByteSource {
    readonly size: number;
    read(offset: number, length: number, into: Uint8Array): number;
    /** Present when the source counts the calls that reached the backend. */
    readonly fetches?: number;
    close?(): void;
  }

  export interface RascRunResult {
    readonly code: number;
    readonly output: Uint8Array;
    readonly reads: number;
    readonly bytes: number;
    readonly fetches: number;
  }

  export interface RascInstance {
    readonly archiveLength: number;
    /** Current linear memory size. wasm memory never shrinks, so it is a high-water mark. */
    readonly wasmMemoryBytes: number;
    setMaxInflatedEntry(bytes: number): number;
    close(): void;
    run(
      args: readonly string[],
      options?: {
        onOutput?: (bytes: Uint8Array) => void;
        /** Entries walked, out of the total the engine knew before it started. */
        onProgress?: (done: number, total: number) => void;
      },
    ): RascRunResult;
  }

  export const Rasc: {
    load(options: {
      wasm: Uint8Array | ArrayBuffer;
      source: RascByteSource;
      maxInflatedEntry?: number;
      onDiagnostic?: (bytes: Uint8Array) => void;
    }): Promise<RascInstance>;
  };

  /** Serves a window at a time, because a raw Blob read costs a real backend call. */
  export function withReadAhead(source: RascByteSource, window?: number): RascByteSource;
  /** Byte source over bytes the host already holds. */
  export function sourceFromBytes(data: Uint8Array | ArrayBuffer): RascByteSource;
}
