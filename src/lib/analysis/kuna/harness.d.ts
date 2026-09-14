/**
 * Types for Kuna's vendored harness.
 *
 * The harness is plain JavaScript copied verbatim from a Kuna checkout, so it
 * ships no declarations and is rewritten wholesale on every refresh. These are
 * written here, in Repi's own tree, for exactly that reason: anything placed
 * beside the vendored files would be deleted by the next `npm run build:kuna`.
 *
 * Only the surface Repi uses is declared. A wider copy would be a second
 * description of Kuna that nobody maintains.
 */

declare module "*/vendor/kuna/kuna-worker-client.js" {
  export class KunaWorkerCancelledError extends Error {
    constructor(message?: string);
  }

  export interface KunaWorkerClientOptions {
    /** Ignored by Repi: `workerFactory` supplies the Worker instead. */
    workerUrl?: URL | string;
    wasmUrl: URL | string;
    specRoot: URL | string;
    smallBundleUrl?: URL | string;
    baseUrl?: string;
    workerFactory?: (url: string, options: WorkerOptions) => Worker;
  }

  export interface KunaEngineFunction {
    readonly name: string;
    readonly address: number;
    readonly address_hex: string;
    readonly aliases: readonly string[];
    readonly size: number;
    readonly kind: "func" | "plt" | "thunk";
  }

  export interface KunaEngineInventory {
    readonly binary: string;
    readonly count: number;
    readonly functions: readonly KunaEngineFunction[];
  }

  export interface KunaEngineResult extends KunaEngineFunction {
    readonly code: string | null;
    readonly error: string | null;
    readonly variables: readonly {
      readonly name: string;
      readonly type: string;
      readonly kind: string;
      readonly arg_index: number | null;
      readonly stack_offset: number | null;
      readonly size: number;
    }[];
  }

  export class KunaWorkerClient {
    constructor(options: KunaWorkerClientOptions);
    readonly generation: number;
    ready(): Promise<unknown>;
    load(
      bytes: Uint8Array | ArrayBuffer,
      options?: { fileName?: string; mode?: string; language?: string },
    ): Promise<KunaEngineInventory & { format: string }>;
    list(): Promise<KunaEngineInventory>;
    decompile(target: string): Promise<{ binary: string; count: number; functions: readonly KunaEngineResult[] }>;
    cancel(message?: string): void;
    close(): void;
  }
}
