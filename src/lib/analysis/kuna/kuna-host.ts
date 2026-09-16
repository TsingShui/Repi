/**
 * Kuna's native CLI, hosted inside the browser.
 *
 * `kuna` itself builds for `wasm32-wasip1`, so the browser does not need a second,
 * reduced command language. A run_js program passes the same argv it would pass to the
 * desktop CLI; this module supplies its two directories (`/work` and `/specs`), appends
 * the trusted SLEIGH location, and exposes only the CLI's read-only analysis commands.
 *
 * The policy belongs here rather than in the agent prompt. The prompt is guidance for a
 * cooperative model; this is the seam that makes a command unable to write a project, an
 * unpacked executable, a FID database, or a compiled spec even if a caller ignores that
 * guidance. The writable `/work` tree still exists because `extract()` supplies native
 * libraries from APKs, but Kuna's own writing commands never reach it.
 *
 * As with the former small web front-end, the small SLEIGH files arrive in one bundle and
 * the large, architecture-specific `.sla` is fetched on demand. Kuna reports the missing
 * language synchronously; the Worker fetches it between two otherwise identical programs.
 */
import type { EngineOutcome } from "../../agent/quickjs-sandbox";
import { MOUNT, mountName, runProgramSync, treeFromPaths } from "../rasc/wasi";
import type { Inode } from "../../../vendor/kuna/vendor/browser_wasi_shim/dist/index.js";

/** `argv[0]`, also the name that native Kuna prints in usage and diagnostics. */
const PROGRAM = "kuna";

/** Where the host mounts the compiled SLEIGH tree. Callers may not override this. */
export const SPEC_ROOT = "/specs";

/** A malformed `.ldefs` must not turn the language index into an unbounded allocation. */
const MAX_LANGUAGES = 20_000;

/**
 * Read-only commands that make sense in the browser.
 *
 * `decompile-project` is intentionally absent: it is a whole-binary export that writes a
 * folder and was both slower and less useful than a selected `decompile-all`/`decompile-graph`
 * query. The other omitted native commands create files, install a skill, compile specs, or
 * run Kuna's own test suite rather than analyse the user's mounted binary.
 */
const COMMANDS = new Map<string, {
  readonly binary: boolean;
  readonly requiresJson?: boolean;
  /** A target is mandatory after the mounted binary — unlike `functions` or `strings`. */
  readonly requiresTarget?: boolean;
}>([
  ["functions", { binary: true }],
  // Text-mode `decompile` drives the native `decomp_dbg` subprocess. Its JSON mode is the
  // same in-process decompiler loop as `decompile-all`, so it works in WASI and is richer.
  ["decompile", { binary: true, requiresJson: true, requiresTarget: true }],
  ["decompile-all", { binary: true }],
  ["decompile-graph", { binary: true }],
  ["strings", { binary: true }],
  ["xrefs", { binary: true }],
  ["read", { binary: true, requiresTarget: true }],
  ["disassemble", { binary: true, requiresTarget: true }],
  ["modes", { binary: false }],
  ["docs", { binary: false }],
  ["help", { binary: false }],
  ["version", { binary: false }],
  ["-V", { binary: false }],
  ["--version", { binary: false }],
]);

function namesFlag(argument: string, flag: string): boolean {
  return argument === flag || argument.startsWith(`${flag}=`);
}

/** A CLI flag that would write, invoke an unavailable child process, or replace the trusted specs. */
function forbiddenArgument(argument: string): string | null {
  if (argument === "-o" || namesFlag(argument, "--output")) {
    return "output files are unavailable; return the command's stdout to JavaScript instead";
  }
  if (/^-o[^-]/.test(argument)) {
    return "output files are unavailable; use stdout instead of -o";
  }
  if (namesFlag(argument, "--sleighpath")) {
    return "the browser supplies its trusted SLEIGH tree automatically";
  }
  if (
    [
      "--jobs",
      "--jobs-chunk",
      "--jobs-full-load",
      "--jobs-worker",
      "--jobs-proto",
      "--jobs-provenance",
      "--jobs-types",
      "--jobs-callees",
      "--decomp-dbg",
    ].some((flag) => namesFlag(argument, flag))
  ) {
    return "process workers are unavailable in browser WASI; commands run serially";
  }
  return null;
}

function hasHelp(argv: readonly string[]): boolean {
  return argv.includes("-h") || argv.includes("--help");
}

function mountedPath(
  value: string | undefined,
  mounts: ReadonlyMap<string, Uint8Array | Blob>,
  readOnly: ReadonlyMap<string, Uint8Array> | undefined,
): boolean {
  if (value === undefined || !value.startsWith(`${MOUNT}/`)) return false;
  const name = value.slice(MOUNT.length + 1);
  return name.length > 0 && (mounts.has(name) || readOnly?.has(name) === true);
}

/**
 * Turns `0x180` into the native CLI's decimal count, leaving every other argument alone.
 *
 * Reverse engineers commonly spell *both* an address and a byte length in hex. Kuna correctly
 * accepts hexadecimal addresses but intentionally parses count/bytes as decimal. The sandbox
 * already has a JavaScript interface rather than a terminal, so normalize the unambiguous
 * numeric value here instead of turning a harmless agent habit into a usage error.
 */
function normalizeHexCounts(command: string, argv: readonly string[]): readonly string[] {
  if (command !== "read" && command !== "disassemble") return argv;
  const out = [...argv];
  for (let index = 0; index < out.length; index += 1) {
    const argument = out[index]!;
    const match = /^(--bytes|--count)=(0x[0-9a-f]+)$/i.exec(argument);
    if (match) {
      out[index] = `${match[1]}=${Number.parseInt(match[2]!, 16)}`;
      continue;
    }
    if ((argument === "--bytes" || argument === "--count") && /^0x[0-9a-f]+$/i.test(out[index + 1] ?? "")) {
      out[index + 1] = String(Number.parseInt(out[index + 1]!, 16));
    }
  }
  return out;
}

/** Flags consuming positional-looking values in commands whose own target is mandatory. */
const TARGET_VALUE_FLAGS = new Set([
  "--as", "--bytes", "--count", "--mode", "--define-function", "--isa", "--slice",
  "--target", "--language", "--max-fn-seconds", "--base", "--sleighpath",
]);

/** A target is the first argument that is not a flag or the value belonging to one. */
function hasTarget(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--option") {
      index += 2;
      continue;
    }
    if (TARGET_VALUE_FLAGS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) continue;
    return true;
  }
  return false;
}

function noSelectionNote(command: string, stdout: string): string {
  if (command !== "functions") return "";
  try {
    const report = JSON.parse(stdout) as { count?: unknown; total?: unknown; error?: unknown };
    if (report.count === 0 && typeof report.total === "number" && report.total > 0 && report.error === null) {
      return "[repi] this function filter selected 0 of " + report.total +
        " discovered functions. Do not pass an empty result to decompile/read/disassemble; use a different filter, functions --summary, or a known address.\n";
    }
  } catch {
    // The engine's own stdout is authoritative; failure to parse a non-JSON request adds no host claim.
  }
  return "";
}

/**
 * Validates and completes native Kuna argv.
 *
 * Binary commands use conventional Kuna ordering (`command`, `binary`, arguments). Requiring
 * the second argument to be a known `/work/...` mount means an analysis run cannot name an
 * invented path even though WASI would make an unmounted path fail later anyway; the useful
 * error appears at the interface where a model can correct it.
 */
function prepareArgs(
  values: readonly string[],
  mounts: ReadonlyMap<string, Uint8Array | Blob>,
  readOnly: ReadonlyMap<string, Uint8Array> | undefined,
): readonly string[] {
  if (values.length === 0) {
    throw new Error(
      "kuna(args) needs native CLI argv, for example kuna(['functions', '/work/libfoo.so', '--json'])",
    );
  }

  const [first, ...initialRest] = values;
  // `values.length` was checked above; naming it after the guard lets TypeScript retain that fact.
  const command = first!;
  const policy = COMMANDS.get(command);
  if (!policy) {
    const note = command === "project" || command === "decompile-project"
      ? "decompile-project is deliberately unavailable in Repi; use decompile-all --functions or decompile-graph --functions instead"
      : "that command is unavailable in Repi's read-only Kuna surface";
    throw new Error(`kuna ${JSON.stringify(command)}: ${note}`);
  }

  // Global commands never take a binary, but agents naturally use the one shape all other
  // calls have. Quietly discard only an actual mounted binary — an arbitrary argument remains
  // an honest CLI error rather than silently changing a query.
  let rest = !policy.binary && mountedPath(initialRest[0], mounts, readOnly)
    ? initialRest.slice(1)
    : initialRest;

  if (policy.binary) {
    // A model sometimes reaches for the mnemonic human order — command, target, binary — even
    // after seeing the native CLI order. The mounted file is unmistakable, so repair only that
    // exact transposition; a missing target still gets a host error rather than guest usage text.
    if (!mountedPath(rest[0], mounts, readOnly) && mountedPath(rest[1], mounts, readOnly)) {
      rest = [rest[1]!, rest[0]!, ...rest.slice(2)];
    }
    if (!mountedPath(rest[0], mounts, readOnly)) {
      throw new Error(`kuna ${command}: expected the mounted binary as argv[1], for example /work/libfoo.so`);
    }
  }

  for (const argument of rest) {
    const reason = forbiddenArgument(argument);
    if (reason) throw new Error(`kuna ${JSON.stringify(command)}: ${reason}`);
  }

  const argv = [command, ...rest];
  // Native help does not open an image, so `kuna(['functions', '--help'])` remains useful.
  if (hasHelp(argv)) return argv;
  if (policy.requiresJson && !rest.some((argument) => argument === "--json")) {
    throw new Error("kuna decompile: browser WASI supports this command with --json; use decompile-all for text batches");
  }
  if (!policy.binary) return argv;
  if (policy.requiresTarget && !hasTarget(rest.slice(1))) {
    throw new Error(`kuna ${command}: needs a function name, address, or address range after the mounted binary`);
  }

  // All binary-analysis subcommands accept this native Kuna option. It is appended after the
  // caller's flags only after rejecting caller-supplied `--sleighpath`, so it cannot be shadowed.
  return [...normalizeHexCounts(command, argv), "--sleighpath", SPEC_ROOT];
}

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

export interface KunaHost {
  /** Runs one read-only, native Kuna CLI command and returns its terminal streams and status. */
  run(
    args: readonly string[],
    mounts: ReadonlyMap<string, Uint8Array | Blob>,
    readOnly?: ReadonlyMap<string, Uint8Array>,
  ): EngineOutcome;
  /** The writable side after the last run: normally only values supplied through `extract()`. */
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

/** Loads the small spec bundle once and returns the browser-side native CLI host. */
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
      parseLdefs(new TextDecoder().decode(bytes), path.slice(0, path.lastIndexOf("/")), languages);
    }
  }

  const fetched = new Set<string>();
  const missing = new Set<string>();
  let leaves = new Map<string, Uint8Array>();

  /** Trims `arch:compiler`-style ids until one resolves, the way Kuna reports them. */
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
      const argv = prepareArgs(args, mounts, readOnly);
      // The attached file, `extract()` results and the conversation's shared VFS all belong
      // under /work. The latter used to be accidentally mounted below /specs, so `ls()` could
      // name a file that Kuna could not open. Kuna's allowed surface is read-only, making the
      // whole binary tree read-only is both correct and a second guard on the command policy.
      const binaries = treeFromPaths([...(readOnly ?? []), ...mounts], { readOnly: true });
      const specs = treeFromPaths(files, { readOnly: true });
      leaves = collectLeaves(mounts);

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
      // The language id carries colons (`x86:LE:64:default:gcc`), so capture it whole then
      // trim by lookup: stopping at the first colon records the wrong spec forever.
      const wanted = /Could not find \.sla file for (\S+)/.exec(stderr)?.[1];
      if (wanted) {
        const spec = specFor(wanted);
        if (spec) {
          const path = `${spec.dir}/${spec.slafile}`;
          if (!fetched.has(path)) missing.add(path);
        }
      }

      const stdout = new TextDecoder().decode(result.stdout);
      const note = missing.size > 0
        ? `\n[kuna] fetching ${[...missing].join(", ")} — call again in a moment\n`
        : "";
      return {
        stdout,
        stderr: stderr + note + noSelectionNote(argv[0]!, stdout),
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
function collectLeaves(mounts: ReadonlyMap<string, Uint8Array | Blob>): Map<string, Uint8Array> {
  // The CLI is mounted read-only. Only `extract()` has created writable values by this point,
  // and these remain visible after the command without copying any shared VFS file into this
  // session's writable overlay.
  return new Map(
    [...mounts].filter((entry): entry is [string, Uint8Array] => entry[1] instanceof Uint8Array),
  );
}

/** The mount map a host hands to Kuna: the attached file plus anything `extract()` produced. */
export function kunaMounts(
  archive: File,
  extracted: ReadonlyMap<string, Uint8Array>,
): Map<string, Uint8Array | Blob> {
  // Under the file's own name, so the CLI path in `ls()` remains the path the user recognises.
  const mounts = new Map<string, Uint8Array | Blob>([[mountName(archive.name), archive]]);
  for (const [name, bytes] of extracted) mounts.set(name, bytes);
  return mounts;
}

/** Re-exported so a caller can type the mount map without importing the engine module. */
export type { Inode };
