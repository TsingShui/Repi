/**
 * The Kuna engine, as a host function.
 *
 * Kuna is `wasm32-wasip1` like rasc, so it runs on the same host: a command line in, two
 * streams and a status out. Two things make it more than a wrapper.
 *
 * **It resolves its language at run time.** Kuna ships the small SLEIGH spec files
 * (`.ldefs`, `.pspec`, `.cspec`) and fetches the one heavy per-language file — the `.sla` —
 * only when a binary needs it, which it announces by failing with
 * `Could not find .sla file for <language-id>`. So a call can end in "I need a file" rather
 * than in an error, and the host answers by fetching that file and letting the program run
 * again. The fetch is asynchronous and an interpreter host function is not, so the missing
 * file is recorded here and the *worker* fetches it once the program has finished — the
 * caller sees a message saying so and its next call works.
 *
 * **Its binary arrives as a path, not as bytes.** The guest opens what the command line
 * names, so the host mounts it: the attached file, or an entry `extract()` pulled out of an
 * APK. The mount is `Blob`-backed, so nothing is copied — which matters because the outer
 * file here is often a whole APK that only holds one `.so` of interest.
 */
import type { EngineOutcome } from "../../agent/quickjs-sandbox";
import { MOUNT, mountName, runProgramSync, treeFromPaths } from "../rasc/wasi";
import type {
  File as ShimFile,
  Inode,
} from "../../../vendor/kuna/vendor/browser_wasi_shim/dist/index.js";

/** Kuna's own name for itself in `argv[0]`, which is what it prints in usage errors. */
const PROGRAM = "kuna_wasm";

/** Where the spec tree is mounted; the guest is told this path in its argument list. */
export const SPEC_ROOT = "/specs";

/** Up to this many languages from one spec bundle: a malformed `.ldefs` cannot loop forever. */
const MAX_LANGUAGES = 20_000;

interface LanguageSpec {
  readonly slafile: string;
  readonly dir: string;
}

export interface KunaHostOptions {
  readonly wasm: WebAssembly.Module;
  /** Base URL the spec tree is served from, without a trailing slash. */
  readonly specRoot: string;
  /** URL of the preloaded small-spec bundle. Defaults to `${specRoot}-small.json`. */
  readonly smallBundleUrl?: string;
}

/** The spec tree, the language index built from it, and what is still missing. */
export interface KunaHost {
  /**
   * Runs one command. `args` is `[binaryPath, command, argument?]` — the mode and language
   * are the host's business and default to `auto`, which follows the binary.
   */
  run(
    args: readonly string[],
    mounts: ReadonlyMap<string, Uint8Array | Blob>,
    readOnly?: ReadonlyMap<string, Uint8Array>,
  ): EngineOutcome;
  /** The writable side after the last run: what Kuna wrote, as plain bytes. */
  leaves(): Map<string, Uint8Array>;
  /** Languages the last run asked for and the host has not fetched yet. */
  missingLanguages(): readonly string[];
  /** Fetches the specs the last run asked for, and returns how many arrived. */
  fetchMissing(): Promise<number>;
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** `id → { slafile, dir }` from the `<language …>` tags of one `.ldefs` file. */
function parseLdefs(text: string, dir: string, into: Map<string, LanguageSpec>): void {
  for (const match of text.matchAll(/<language\b([\s\S]*?)>/g)) {
    const attributes = match[1] ?? "";
    const id = /id="([^"]*)"/.exec(attributes)?.[1];
    const slafile = /slafile="([^"]*)"/.exec(attributes)?.[1];
    if (id && slafile && into.size < MAX_LANGUAGES) into.set(id, { slafile, dir });
  }
}

/**
 * Loads the small spec bundle once and returns the host.
 *
 * This is the work Kuna's own web harness does in JavaScript; it lives here instead because
 * the harness belongs to the other application, and all this engine needs from it is the spec
 * tree and the language index.
 */
export async function createKunaHost(options: KunaHostOptions): Promise<KunaHost> {
  const base = options.specRoot.replace(/\/$/, "");
  const bundleUrl = options.smallBundleUrl ?? `${base}-small.json`;
  const response = await fetch(bundleUrl);
  if (!response.ok) throw new Error(`the spec bundle was not found (${response.status}): ${bundleUrl}`);

  const bundle = (await response.json()) as Record<string, string>;
  const languages = new Map<string, LanguageSpec>();
  const files = new Map<string, Uint8Array | Blob>();
  for (const [path, encoded] of Object.entries(bundle)) {
    const bytes = base64ToBytes(encoded);
    files.set(path, bytes);
    if (path.endsWith(".ldefs")) {
      parseLdefs(
        new TextDecoder().decode(bytes),
        path.slice(0, path.lastIndexOf("/")),
        languages,
      );
    }
  }

  const fetched = new Set<string>();
  const missing = new Set<string>();
  let leaves = new Map<string, Uint8Array>();

  /** Trims `arch:compiler`-style ids until one resolves, the way the engine reports them. */
  function specFor(id: string): LanguageSpec | null {
    let key = id;
    while (key.length > 0) {
      const hit = languages.get(key);
      if (hit) return hit;
      const cut = key.lastIndexOf(":");
      if (cut < 0) return null;
      key = key.slice(0, cut);
    }
    return null;
  }

  return {
    run(args, mounts, readOnly) {
      const [binary, command, argument] = args;
      if (binary === undefined || command === undefined) {
        return {
          stdout: "",
          stderr: "kuna() takes [binaryPath, command, argument?]",
          code: 1,
        };
      }

      // The binary the guest opens: the attached file, or something extract() mounted.
      const name = binary.startsWith("/") ? binary.replace(`${MOUNT}/`, "") : binary;
      const mounted = new Map<string, Uint8Array | Blob>(mounts);
      if (!mounted.has(name)) {
        // The host mounts what it has; a path that is not there is a program asking for a file
        // nobody put in the sandbox.
        throw new Error(`${name} is not mounted for kuna. ls() lists what is.`);
      }

      // Two mounts, because the guest is told about two paths: the binary it opens, and the
      // tree it resolves a SLEIGH language in. Mixing them into one tree puts the specs where
      // the engine does not look, and the failure reads like a missing architecture.
      const binaries = treeFromPaths(mounted);
      const specs = treeFromPaths([...(readOnly ?? []), ...files], { readOnly: true });
      leaves = collectLeaves(binaries.files, mounted);
      const argv = [binary, SPEC_ROOT, command];
      if (argument !== undefined) argv.push(argument);
      argv.push("--mode", "auto", "--language", "auto");

      const result = runProgramSync({
        wasm: options.wasm,
        name: PROGRAM,
        args: argv,
        mounts: [
          { path: MOUNT, tree: binaries.tree },
          { path: SPEC_ROOT, tree: specs.tree },
        ],
      });

      const stderr = new TextDecoder().decode(result.stderr);
      // The language id carries colons (`x86:LE:64:default:gcc`), so it is captured whole and
      // trimmed by lookup: stopping at the first colon records the wrong thing and the engine
      // asks again forever.
      const wanted = /Could not find \.sla file for (\S+)/.exec(stderr)?.[1];
      if (wanted) {
        const spec = specFor(wanted);
        if (spec) {
          const path = `${spec.dir}/${spec.slafile}`;
          if (!fetched.has(path)) missing.add(path);
        }
      }

      const note = missing.size > 0
        ? `\n[kuna] fetching ${[...missing].join(", ")} — call again in a moment\n`
        : "";

      return {
        stdout: new TextDecoder().decode(result.stdout),
        stderr: stderr + note,
        code: result.code,
      };
    },

    missingLanguages: () => [...missing],

    leaves: () => new Map(leaves),

    async fetchMissing() {
      let arrived = 0;
      for (const path of [...missing]) {
        missing.delete(path);
        if (fetched.has(path)) continue;
        const response = await fetch(`${base}/${path}`);
        if (!response.ok) throw new Error(`the spec ${path} was not found (${response.status})`);
        files.set(path, new Uint8Array(await response.arrayBuffer()));
        fetched.add(path);
        arrived += 1;
      }
      return arrived;
    },
  };
}

/** The writable leaves of one run, copied out of the shim's buffers. */
function collectLeaves(
  // The shim's `File`, not the DOM's: same name, different object, and only this one has `data`.
  files: ReadonlyMap<string, ShimFile>,
  mounts: ReadonlyMap<string, Uint8Array | Blob>,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [name, value] of mounts) if (value instanceof Uint8Array) out.set(name, value);
  for (const [name, file] of files) out.set(name, new Uint8Array(file.data));
  return out;
}

/** The mount map a host hands to Kuna: the attached file plus anything `extract()` produced. */
export function kunaMounts(
  archive: File,
  extracted: ReadonlyMap<string, Uint8Array>,
): Map<string, Uint8Array | Blob> {
  // Under the file's own name, so the path in a command line is the path the user recognises and
  // the one `ls()` reports: an ELF is not an `archive.apk` and should not be told it is.
  const mounts = new Map<string, Uint8Array | Blob>([[mountName(archive.name), archive]]);
  for (const [name, bytes] of extracted) mounts.set(name, bytes);
  return mounts;
}

/** Re-exported so a caller can type the mount map without importing the engine module. */
export type { Inode };
