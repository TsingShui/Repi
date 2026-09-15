/**
 * Assembles the Rasc decompiler that Repi serves.
 *
 * Rasc is a separate repository, and this script is the only thing that knows
 * that. It reads a checkout, builds the wasm, and lays out what the page fetches:
 *
 *   public/rasc/          the wasm module and the licences. Gitignored — build
 *                         output, and the module is the only artifact the page
 *                         fetches at runtime.
 *   src/vendor/rasc/      the reference WASI host, copied from the same checkout.
 *                         Committed, because the Node-side oracle imports it and a
 *                         missing module is a build failure. Refreshing it is what
 *                         this script does.
 *
 * The split is deliberate and the same one `build-kuna.mjs` makes: the parts the
 * bundler must resolve are in the repository, and the parts that are merely
 * fetched are not. Without a checkout the application still builds and still
 * runs — it reports that the engine is missing instead of pretending to have one.
 *
 * Usage:
 *   node scripts/build-rasc.mjs                 # build wasm and assemble
 *   node scripts/build-rasc.mjs --skip-build    # reuse the wasm already built
 *   RASC_REPO=/path/to/rasc node scripts/build-rasc.mjs
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const repoRoot = resolve(projectRoot, "..");

const rascRepo = resolve(process.env.RASC_REPO ?? join(homedir(), "rasc"));
const skipBuild = process.argv.includes("--skip-build");

const publicDir = join(projectRoot, "public/rasc");
const vendorDir = join(projectRoot, "src/vendor/rasc");
/**
 * Rasc builds for `wasm32-wasip1`: the engine is a **program**, not a host module. It
 * takes `argv`, an environment, a directory it was given access to, and it writes
 * stdout and stderr - the same shape Kuna already has, and the reason neither engine
 * needs a bespoke host glue here.
 */
const TARGET = "wasm32-wasip1";
const wasmSource = join(rascRepo, `target/${TARGET}/release/rasc.wasm`);

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${command} exited ${code}`))));
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The commit the artifacts came from, not the branch that happened to be checked out. */
async function rascCommit() {
  try {
    const head = (await readFile(join(rascRepo, ".git/HEAD"), "utf8")).trim();
    if (!head.startsWith("ref: ")) return head;
    return (await readFile(join(rascRepo, ".git", head.slice(5)), "utf8")).trim();
  } catch {
    return "unknown";
  }
}

function human(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ------------------------------------------------------------------ checks

if (!(await exists(join(rascRepo, "Cargo.toml")))) {
  console.error(`No rasc checkout at ${rascRepo}.`);
  console.error(`Set RASC_REPO, or clone github.com/TsingShui/rasc next to this repository.`);
  process.exit(1);
}

console.log(`>> rasc checkout: ${rascRepo}`);

// ------------------------------------------------------------------- wasm

if (skipBuild) {
  console.log(">> skipping the wasm build");
} else {
  console.log(`>> building rasc (${TARGET}, release)`);
  await run("cargo", ["build", "--release", "--target", TARGET], {
    cwd: rascRepo,
  });
}

if (!(await exists(wasmSource))) {
  console.error(`The build produced no wasm at ${wasmSource}`);
  process.exit(1);
}

// ----------------------------------------------------------------- output

await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
await cp(wasmSource, join(publicDir, "rasc.wasm"));

// --------------------------------------------------------- vendor refresh

await rm(vendorDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });
// The reference WASI host: plain JavaScript, no imports, and the only thing that knows how a
// command line reaches the engine. `src/vendor/rasc/wasi.mjs` is what the Node-side oracle
// and the checks drive the engine with; the page's own host is the analogous Worker under
// `src/lib/analysis/rasc/`.
await cp(join(rascRepo, "js/wasi-run.mjs"), join(vendorDir, "wasi-run.mjs"));

// ------------------------------------------------------------- attribution

// Apache-2.0. The licence and the notice travel with the artifacts because the
// artifacts are redistributed.
for (const file of ["LICENSE", "NOTICE"]) {
  if (await exists(join(rascRepo, file))) {
    await cp(join(rascRepo, file), join(publicDir, `RASC-${file}`));
  }
}
await writeFile(
  join(publicDir, "PROVENANCE.md"),
  `# Rasc build provenance

Built from a local checkout by \`scripts/build-rasc.mjs\`.

- Source: ${rascRepo}
- Commit: ${await rascCommit()}
- Target: ${TARGET}, release

Rasc is Apache-2.0; the full text is in \`RASC-LICENSE\` and the attribution in
\`RASC-NOTICE\`. The vendored host glue in \`src/vendor/rasc/rasc.mjs\` is copied
from the same commit.
`,
);

// ------------------------------------------------------------------ report

console.log(">> assembled public/rasc/");
console.log(`   wasm: ${human((await stat(join(publicDir, "rasc.wasm"))).size)}`);
console.log(`   refreshed src/vendor/rasc/wasi-run.mjs from ${rascRepo}`);
