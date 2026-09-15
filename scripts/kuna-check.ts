/**
 * Kuna, through the host the sandbox calls it with.
 *
 * This is the check that the bridge is real: the wasm is Kuna's own build, the spec tree is
 * the one `npm run build:kuna` assembles, and the two are driven exactly as the Worker drives
 * them — a command line in, two streams and a status out, with the language resolved by
 * failing once and fetching what the engine asked for.
 *
 * What it covers that nothing else can:
 *
 *  - the argument list the guest actually parses (`<binary> <spec-root> <cmd> [arg]`),
 *  - the small-spec bundle really is enough to start (`list` works without any `.sla`),
 *  - a `.sla` that is missing is *named by the engine*, recorded, fetched, and the same call
 *    succeeds on the second attempt — which is the whole reason the fetch happens between
 *    programs instead of inside one,
 *  - and the sandbox sees all of it through `kuna(args)`.
 *
 * The spec tree is served over HTTP because that is how the browser fetches it; `fetch` will
 * not read `file:` URLs.
 *
 *   node scripts/run-analysis-check.mjs kuna-check
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKunaHost } from "../src/lib/analysis/kuna/kuna-host";
import { Sandbox } from "../src/lib/agent/quickjs-sandbox";
import type { EngineOutcome } from "../src/lib/agent/quickjs-sandbox";

const projectRoot = process.env.REPI_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const served = resolve(projectRoot, "public/kuna");
const ARCHIVE = "/work/input.bin";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

// ------------------------------------------------------------------ the spec tree

const TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".sla": "application/octet-stream",
  ".ldefs": "application/xml",
  ".pspec": "application/xml",
  ".cspec": "application/xml",
  ".elf": "application/octet-stream",
};

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
  const target = resolve(served, `.${path}`);
  if (!target.startsWith(served)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(target);
    const extension = target.slice(target.lastIndexOf("."));
    response.writeHead(200, { "content-type": TYPES[extension] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;

try {
  const bundled = await readFile(resolve(served, "specs-small.json"), "utf8").catch(() => null);
  if (bundled === null) {
    console.log("skip: run `npm run build:kuna` first (public/kuna is the engine)");
    process.exit(0);
  }

  const wasm = await WebAssembly.compile(await readFile(resolve(served, "kuna_wasm.wasm")));
  const binary = await readFile(resolve(served, "fixtures/sample.elf"));
  const mounts = new Map<string, Uint8Array>([["input.bin", binary]]);

  const host = await createKunaHost({
    wasm,
    specRoot: `${origin}/specs`,
    smallBundleUrl: `${origin}/specs-small.json`,
  });

  // ------------------------------------------------ the loop: fail, fetch, retry

  const firstList = host.run([ARCHIVE, "list"], mounts);
  const asked = /Could not find \.sla file for (\S+)/.exec(firstList.stderr)?.[1];
  check(
    "the engine names the language it needs",
    firstList.code !== 0 && asked !== undefined,
    `exit ${firstList.code}, asked for ${asked ?? "nothing"}`,
  );
  check(
    "the host records it and says so in the answer",
    host.missingLanguages().length > 0 && firstList.stderr.includes("[kuna] fetching"),
    host.missingLanguages().join(", "),
  );

  const arrived = await host.fetchMissing();
  check("the fetch happens between programs", arrived > 0, `${arrived} spec file(s)`);
  check("and nothing is left pending", host.missingLanguages().length === 0);

  const listed = host.run([ARCHIVE, "list"], mounts);
  let inventory: { count?: number; functions?: { name?: string }[] } = {};
  try {
    inventory = JSON.parse(listed.stdout) as typeof inventory;
  } catch {
    /* reported below */
  }
  const names = (inventory.functions ?? []).map((entry) => entry.name ?? "").filter(Boolean);
  check(
    "the same call succeeds once the spec is there",
    listed.code === 0 && (inventory.count ?? 0) > 0 && names.length > 0,
    `exit ${listed.code}, ${inventory.count ?? 0} functions, first ${names[0] ?? "-"}` +
      (listed.code === 0 ? "" : ` — ${(listed.stderr.trim().split("\n")[0] ?? "")}`),
  );

  // ------------------------------------------------------------------- decompile

  const target = names[0];
  if (target === undefined) {
    check("a function to decompile", false, "the inventory was empty");
  } else {
    const decompiled = host.run([ARCHIVE, "decompile", target], mounts);
    let document: { functions?: { code?: string | null }[] } = {};
    try {
      document = JSON.parse(decompiled.stdout) as typeof document;
    } catch {
      /* reported below */
    }
    const code = (document.functions ?? []).map((entry) => entry.code ?? "").join("\n");
    check(
      "decompiling a function returns C",
      decompiled.code === 0 && code.includes(target) && code.includes("{"),
      `exit ${decompiled.code}, ${code.length} bytes of C`,
    );
  }

  // -------------------------------------------------------------- through the sandbox

  const sandbox = new Sandbox(
    {
      functions: {
        kuna: (args): EngineOutcome =>
          host.run(
            args.map((arg) => String(arg)),
            mounts,
          ),
      },
    },
    { deadlineMs: 60_000, memoryBytes: 512 << 20 },
  );

  const outcome = await sandbox.run(`
    const inventory = JSON.parse(kuna(['${ARCHIVE}', 'list']).stdout);
    const target = inventory.functions[0].name;
    let out = kuna(['${ARCHIVE}', 'decompile', target]);
    if (out.code !== 0) out = kuna(['${ARCHIVE}', 'decompile', target]);  // the spec arrives between runs
    const first = JSON.parse(out.stdout).functions[0];
    return JSON.stringify({ count: inventory.count, target, c: first.code.slice(0, 60) });
  `);

  if (outcome.error === null && outcome.result !== null) {
    const summary = JSON.parse(outcome.result) as { count: number; target: string; c: string };
    check(
      "a program sees the engine through kuna(args)",
      summary.count > 0 && summary.c.length > 0,
      `${summary.count} functions, ${summary.target}: ${summary.c.replaceAll("\n", " ").slice(0, 50)}`,
    );
  } else {
    check(
      "a program sees the engine through kuna(args)",
      false,
      outcome.error ? `${outcome.error.name}: ${outcome.error.message}` : "no result",
    );
  }
  check(
    "the engine call is the expensive part, and it is counted",
    outcome.calls >= 2,
    `${outcome.calls} engine call(s), ${outcome.ms} ms`,
  );
} finally {
  server.close();
}

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log("\nall kuna checks passed");
