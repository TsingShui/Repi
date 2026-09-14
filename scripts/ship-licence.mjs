/**
 * Copies the licence into the thing that gets served.
 *
 * Serving the page is distributing it, and Apache-2.0 requires that whoever
 * receives the distribution receives the licence with it. The file lives at the
 * repository root because that is where people and tooling look for it, and this
 * puts the same file next to the artifact rather than keeping a second copy that
 * would drift.
 *
 * A `.mjs` script rather than a Vite plugin on purpose: `vite.config.ts` is type
 * checked, this repository has no `@types/node`, and adding a dependency so that
 * a build step can call `copyFileSync` is a poor trade for eight lines. It read
 * `../LICENSE` while the application was a directory inside the Pi package's
 * repository; the licence is at this repository's root now.
 *
 * Usage: `node scripts/ship-licence.mjs [outDir]`, run after `vite build`.
 */
import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const out = resolve(projectRoot, process.argv[2] ?? "dist");

// Each is required to be present: a licence that silently did not ship is the
// failure this exists to prevent, so it fails loudly instead.
for (const file of ["LICENSE", "NOTICE"]) {
  copyFileSync(resolve(projectRoot, file), resolve(out, file));
  console.log(`>> ${file} -> ${resolve(out, file).replace(`${projectRoot}/`, "")}`);
}
