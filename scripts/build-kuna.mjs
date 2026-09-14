/**
 * Assembles the Kuna decompiler that Repi serves.
 *
 * Kuna is a separate repository, and this script is the only thing that knows
 * that. It reads a checkout, builds the wasm, and lays out what the page fetches:
 *
 *   public/kuna/          the wasm, the SLEIGH tree, the preload bundle, the
 *                         licences. Gitignored — 20 MB of build output.
 *   src/vendor/kuna/      the harness (a Worker, a client and a JS WASI shim).
 *                         Committed, because the page imports it statically and
 *                         a missing module is a build failure. 160 KB, and
 *                         refreshing it is what this script does.
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

const kunaRepo = resolve(process.env.KUNA_REPO ?? join(homedir(), "zhome/kuna"));
const skipBuild = process.argv.includes("--skip-build");

const publicDir = join(projectRoot, "public/kuna");
const vendorDir = join(projectRoot, "src/vendor/kuna");
const wasmSource = join(kunaRepo, "decompiler/target/wasm32-wasip1/release/kuna_wasm.wasm");

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
  console.error(`Set KUNA_REPO, or clone github.com/TsingShui/kuna next to this repository.`);
  process.exit(1);
}

console.log(`>> kuna checkout: ${kunaRepo}`);

// ------------------------------------------------------------------- wasm

if (skipBuild) {
  console.log(">> skipping the wasm build");
} else {
  console.log(">> building kuna_wasm (wasm32-wasip1, release)");
  await run("cargo", ["build", "--release", "--target", "wasm32-wasip1", "-p", "kuna-wasm"], {
    cwd: join(kunaRepo, "decompiler"),
  });
}

if (!(await exists(wasmSource))) {
  console.error(`The build produced no wasm at ${wasmSource}`);
  process.exit(1);
}

// ------------------------------------------------------------------ specs

const specsSource = join(kunaRepo, "specs");
const runtimeFiles = (await walk(specsSource)).filter((path) =>
  RUNTIME_EXTENSIONS.includes(path.split(".").pop()),
);
const slas = runtimeFiles.filter((path) => path.endsWith(".sla"));

if (slas.length === 0) {
  console.error(`No .sla under ${specsSource}. Run \`make specs\` in the kuna checkout first.`);
  process.exit(1);
}

// ----------------------------------------------------------------- output

await rm(publicDir, { recursive: true, force: true });
await mkdir(join(publicDir, "specs"), { recursive: true });

await cp(wasmSource, join(publicDir, "kuna_wasm.wasm"));

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

// --------------------------------------------------------- vendor refresh

const web = join(kunaRepo, "integrations/web");
await rm(vendorDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });

for (const file of ["kuna-web.js", "kuna-worker.js", "kuna-worker-client.js", "zip.js"]) {
  await cp(join(web, file), join(vendorDir, file));
}
// `kuna-web.js` imports `./vendor/browser_wasi_shim/dist/index.js`, so the path
// is kept exactly as it is upstream and the refresh stays a straight copy.
await cp(join(web, "vendor/browser_wasi_shim"), join(vendorDir, "vendor/browser_wasi_shim"), {
  recursive: true,
});

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

Kuna is Apache-2.0 and is derived from Ghidra, also Apache-2.0. See
\`KUNA-LICENSE\` and \`KUNA-NOTICE\`. The vendored WASI shim in
\`src/vendor/kuna/vendor/browser_wasi_shim\` is @bjorn3/browser_wasi_shim,
MIT/Apache-2.0.
`,
);

// ------------------------------------------------------------------ report

const measurements = [
  ["wasm", join(publicDir, "kuna_wasm.wasm")],
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
console.log(`   refreshed src/vendor/kuna/ from ${relative(repoRoot, web)}`);
