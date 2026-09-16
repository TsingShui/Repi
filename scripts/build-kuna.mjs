/**
 * Assembles the Kuna decompiler that Repi serves.
 *
 * Kuna is a separate repository, and this script is the only thing that knows
 * that. It reads a checkout, builds the wasm, and lays out what the page fetches:
 *
 *   public/kuna/          the wasm, the SLEIGH tree, the preload bundle, the
 *                         licences. Gitignored — 20 MB of build output.
 *   src/vendor/kuna/      the WASI shim plus Repi's tiny CLI-WASI compatibility
 *                         patch, committed as browser build dependencies. The engine's own
 *                         JavaScript harness is **not** vendored
 *                         any more: the native Kuna CLI is a wasm32-wasip1 program,
 *                         so the page mounts it and calls its read-only analysis commands
 *                         like any other program. The browser host owns the spec tree and
 *                         lazy `.sla` lookup in `lib/analysis/kuna/kuna-host.ts`.
 *
 * The split is deliberate: the parts the bundler must resolve are in the
 * repository, and the parts that are merely fetched are not. Without a checkout
 * the application still builds and still runs — it reports that the engine is
 * missing instead of pretending to have one.
 *
 * Usage:
 *   node scripts/build-kuna.mjs                 # build wasm and assemble
 *   node scripts/build-kuna.mjs --skip-build    # reuse the wasm already built
 *   KUNA_REPO=/path/to/kuna node scripts/build-kuna.mjs
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const repoRoot = resolve(projectRoot, "..");

const kunaRepo = resolve(process.env.KUNA_REPO ?? join(homedir(), "zhome", "kuna"));
const skipBuild = process.argv.includes("--skip-build");

const publicDir = join(projectRoot, "public/kuna");
const vendorDir = join(projectRoot, "src/vendor/kuna");
const wasmSource = join(kunaRepo, "decompiler/target/wasm32-wasip1/release/kuna.wasm");
// Rust's WASI stdlib does not implement canonicalize(). The native CLI uses it in three
// read-only query paths, so this small Repi-owned patch keeps the virtual /work path as-is
// when compiling for WASI. It is applied only for the cargo invocation and reversed in finally:
// building Repi never leaves a change in the user's Kuna checkout.
const wasmCliPatch = join(projectRoot, "src/vendor/kuna/patches/cli-wasi-paths.patch");

/** The runtime files the decompiler actually reads. `.slaspec` sources are never read. */
const RUNTIME_EXTENSIONS = ["ldefs", "pspec", "cspec", "dwarf", "sla"];
/** Everything but the per-language `.sla`, which is fetched lazily instead. */
const PRELOAD_EXTENSIONS = ["ldefs", "pspec", "cspec", "dwarf"];

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${command} exited ${code}`))));
  });
}

/** The commit the artifacts came from, not the branch that happened to be checked out. */
async function kunaCommit() {
  try {
    const head = (await readFile(join(kunaRepo, ".git/HEAD"), "utf8")).trim();
    if (!head.startsWith("ref: ")) return head;
    return (await readFile(join(kunaRepo, ".git", head.slice(5)), "utf8")).trim();
  } catch {
    return "unknown";
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

function human(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ------------------------------------------------------------------ checks

if (!(await exists(join(kunaRepo, "decompiler/Cargo.toml")))) {
  console.error(`No kuna checkout at ${kunaRepo}.`);
  console.error(`Set KUNA_REPO, or clone github.com/Noelo-Lab/kuna next to this repository.`);
  process.exit(1);
}

console.log(`>> kuna checkout: ${kunaRepo}`);

// ------------------------------------------------------------------- wasm

let patchApplied = false;
try {
  if (skipBuild) {
    console.log(">> skipping the wasm build");
  } else {
    if (!(await exists(wasmCliPatch))) throw new Error(`The vendored WASI patch is missing: ${wasmCliPatch}`);
    // Check before changing anything. A patch conflict says this Kuna revision needs a fresh
    // vendor patch; blindly applying a half-match would be worse than declining to build.
    await run("git", ["apply", "--check", wasmCliPatch], { cwd: kunaRepo });
    await run("git", ["apply", wasmCliPatch], { cwd: kunaRepo });
    patchApplied = true;
    console.log(">> building Kuna CLI (wasm32-wasip1, release; temporary Repi WASI patch)");
    await run("cargo", ["build", "--release", "--target", "wasm32-wasip1", "-p", "kuna-cli"], {
      cwd: join(kunaRepo, "decompiler"),
    });
  }

  if (!(await exists(wasmSource))) throw new Error(`The build produced no wasm at ${wasmSource}`);

  // ------------------------------------------------------------------ specs

  const specsSource = join(kunaRepo, "specs");
  const runtimeFiles = (await walk(specsSource)).filter((path) =>
    RUNTIME_EXTENSIONS.includes(path.split(".").pop()),
  );
  const slas = runtimeFiles.filter((path) => path.endsWith(".sla"));

  if (slas.length === 0) {
    throw new Error(`No .sla under ${specsSource}. Run \`make specs\` in the kuna checkout first.`);
  }

  // ----------------------------------------------------------------- output

  await rm(publicDir, { recursive: true, force: true });
  await mkdir(join(publicDir, "specs"), { recursive: true });

  await cp(wasmSource, join(publicDir, "kuna.wasm"));

  // The tree keeps its shape: the engine resolves a language by scanning it, so
  // flattening it would break the lookup that makes the lazy `.sla` fetch work.
  for (const path of runtimeFiles) {
    const target = join(publicDir, "specs", relative(specsSource, path).split(sep).join("/"));
    await mkdir(dirname(target), { recursive: true });
    await cp(path, target);
  }

  const preload = {};
  for (const path of runtimeFiles) {
    if (!PRELOAD_EXTENSIONS.includes(path.split(".").pop())) continue;
    const key = relative(specsSource, path).split(sep).join("/");
    preload[key] = (await readFile(path)).toString("base64");
  }
  await writeFile(join(publicDir, "specs-small.json"), JSON.stringify(preload));

// --------------------------------------------------------- vendor shim

// Nothing to refresh. The shim under `src/vendor/kuna/vendor/` is the WASI preview1
// implementation both engines link against, and it is committed: it is a dependency of the
// page, not an artifact of this build, and re-copying it would make the application's build
// depend on a checkout it does not otherwise need.
const web = join(kunaRepo, "integrations/web");

// --------------------------------------------------------------- fixtures

// The engine needs a real binary: a synthetic header has no code to decompile.
// Kuna's own test fixtures are copied rather than committed here, so they always
// match the engine version that was just built.
const fixtureDir = join(publicDir, "fixtures");
await mkdir(fixtureDir, { recursive: true });
for (const file of ["sample.elf", "sample_aarch64.o", "sample.c", "sample_aarch64.c"]) {
  const from = join(web, "test/fixtures", file);
  if (await exists(from)) await cp(from, join(fixtureDir, file));
}

// ------------------------------------------------------------- attribution

// Apache-2.0, and derived from Ghidra, which is also Apache-2.0. The licence and
// the notice travel with the artifacts because the artifacts are redistributed.
for (const file of ["LICENSE", "NOTICE"]) {
  if (await exists(join(kunaRepo, file))) await cp(join(kunaRepo, file), join(publicDir, `KUNA-${file}`));
}
await writeFile(
  join(publicDir, "PROVENANCE.md"),
  `# Kuna build provenance

Built from a local checkout by \`scripts/build-kuna.mjs\`.

- Source: ${kunaRepo}
- Commit: ${await kunaCommit()}
- Target: wasm32-wasip1, release
- Runtime SLEIGH files: ${runtimeFiles.length} (${slas.length} \`.sla\`, lazily fetched)
- Repi applied and then reversed \`src/vendor/kuna/patches/cli-wasi-paths.patch\` for this build.

Kuna is Apache-2.0 and is derived from Ghidra, also Apache-2.0. See
\`KUNA-LICENSE\` and \`KUNA-NOTICE\`. The vendored WASI shim in
\`src/vendor/kuna/vendor/browser_wasi_shim\` is @bjorn3/browser_wasi_shim,
MIT/Apache-2.0.
`,
);

// ------------------------------------------------------------------ report

const measurements = [
  ["wasm", join(publicDir, "kuna.wasm")],
  ["preload bundle", join(publicDir, "specs-small.json")],
];
console.log(">> assembled public/kuna/");
for (const [label, path] of measurements) {
  console.log(`   ${label}: ${human((await stat(path)).size)}`);
}
const specBytes = (await walk(join(publicDir, "specs"))).reduce(async (total, path) => (await total) + (await stat(path)).size, Promise.resolve(0));
console.log(`   specs: ${human(await specBytes)} across ${runtimeFiles.length} files`);
const everything = (await walk(publicDir)).reduce(async (total, path) => (await total) + (await stat(path)).size, Promise.resolve(0));
console.log(`   total served: ${human(await everything)}`);
console.log("   src/vendor/kuna/ holds the WASI shim and the Repi WASI compatibility patch");
} finally {
  if (patchApplied) {
    // Do not turn a build dependency into an uncommitted change in another repository.
    await run("git", ["apply", "--reverse", wasmCliPatch], { cwd: kunaRepo });
    console.log(">> restored the Kuna checkout after the temporary WASI patch");
  }
}
