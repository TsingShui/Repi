/**
 * Bundles one check file for Node and runs it.
 *
 *   node scripts/run-analysis-check.mjs                 # analysis-check (default)
 *   node scripts/run-analysis-check.mjs sandbox-check   # the sandbox and the extractor
 *
 * The checks are written in TypeScript against the app's own modules, so they go
 * through Vite once to resolve those imports, then run as a plain ESM file. No
 * browser and no test framework are involved.
 */
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const entry = process.argv[2] ?? "analysis-check";
/*
 * Inside the project, not in the system temp directory: the bundle keeps its imports
 * external, so `node_modules` has to be reachable from where it lands — and a dependency
 * that carries a `.wasm` beside its glue (the interpreter does) needs its real path, which a
 * copy into `/tmp` would break.
 */
const outDir = join(projectRoot, ".cache", "checks", entry);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

/*
 * A guard on the source, because the test that would catch this properly needs a
 * subpath deployment and this does not.
 *
 * Both engines were written with `const ARTIFACT_ROOT = "/kuna/"` and `"/rasc/"`,
 * and both were wrong: the build sets `base: "./"` so the site can live under a
 * subpath, where a root-absolute path asks a project page for a directory that is
 * not its own. It shipped to GitHub Pages and the live site reported Rasc as not
 * installed while `rasc.wasm` was being served with a 200.
 *
 * Every driver must go through `artifactUrl`.
 */
{
  const engineDir = resolve(projectRoot, "src/lib/analysis");
  const drivers = (await readdir(engineDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(engineDir, entry.name, "driver.ts"));

  const offenders = [];
  for (const driver of drivers) {
    // Not every directory under lib/analysis is an engine: the archive helpers live there
    // too, and a missing driver.ts is simply not this guard's business.
    const exists = await stat(driver).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    const source = await readFile(driver, "utf8");
    for (const match of source.matchAll(/["'`]\/(kuna|rasc)\//g)) {
      offenders.push(`${driver.replace(`${projectRoot}/`, "")}: ${match[0]}`);
    }
  }

  if (offenders.length > 0) {
    console.error("Root-absolute engine paths found. Use artifactUrl() instead:");
    for (const offender of offenders) console.error(`  ${offender}`);
    process.exit(1);
  }
}

try {
  await build({
    configFile: false,
    root: projectRoot,
    logLevel: "warn",
    build: {
      ssr: true,
      minify: false,
      outDir,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(here, `${entry}.ts`),
        output: { entryFileNames: `${entry}.mjs`, format: "es" },
      },
    },
  });

  // The bundle runs from `.cache/checks/<entry>/`, so a check cannot find the project by
  // walking up from `import.meta.url`; it is handed over instead.
  process.env.REPI_ROOT = projectRoot;
  await import(pathToFileURL(join(outDir, `${entry}.mjs`)).href);
} finally {
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
}
