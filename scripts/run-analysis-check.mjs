/**
 * Bundles `analysis-check.ts` for Node and runs it.
 *
 * The checks are written in TypeScript against the app's own modules, so they go
 * through Vite once to resolve those imports, then run as a plain ESM file. No
 * browser and no test framework are involved.
 */
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const outDir = await mkdtemp(join(tmpdir(), "repi-analysis-check-"));

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
        input: resolve(here, "analysis-check.ts"),
        output: { entryFileNames: "analysis-check.mjs", format: "es" },
      },
    },
  });

  await import(pathToFileURL(join(outDir, "analysis-check.mjs")).href);
} finally {
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
}
