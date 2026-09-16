/**
 * The native Kuna CLI, through the same browser host that a sandbox calls.
 *
 * This verifies the useful seam rather than a bespoke browser command language:
 * a run_js program gives Kuna native CLI argv, the host fixes the SLEIGH location,
 * rejects commands that can write, and retries after fetching exactly one missing `.sla`.
 *
 * It needs `npm run build:kuna` first, because public/kuna is intentionally build output.
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

  const wasm = await WebAssembly.compile(await readFile(resolve(served, "kuna.wasm")));
  const binary = await readFile(resolve(served, "fixtures/sample.elf"));
  const mounts = new Map<string, Uint8Array>([["input.bin", binary]]);
  const host = await createKunaHost({
    wasm,
    specRoot: `${origin}/specs`,
    smallBundleUrl: `${origin}/specs-small.json`,
  });

  // ------------------------------------------------ the loop: fail, fetch, retry

  const firstFunctions = host.run(["functions", ARCHIVE, "--json"], mounts);
  const asked = /Could not find \.sla file for (\S+)/.exec(firstFunctions.stderr)?.[1];
  check(
    "the engine names the language it needs",
    firstFunctions.code !== 0 && asked !== undefined,
    `exit ${firstFunctions.code}, asked for ${asked ?? "nothing"}`,
  );
  check(
    "the host records it and says so in the answer",
    host.missingLanguages().length > 0 && firstFunctions.stderr.includes("[kuna] fetching"),
    host.missingLanguages().join(", "),
  );

  const arrived = await host.fetchMissing();
  check("the fetch happens between programs", arrived > 0, `${arrived} spec file(s)`);
  check("and nothing is left pending", host.missingLanguages().length === 0);

  const listed = host.run(["functions", ARCHIVE, "--json"], mounts);
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

  // ----------------------------------------------------------- native CLI queries

  const strings = host.run(["strings", ARCHIVE, "--json", "--no-xrefs"], mounts);
  let stringsDocument: { strings?: unknown[] } = {};
  try {
    stringsDocument = JSON.parse(strings.stdout) as typeof stringsDocument;
  } catch {
    /* reported below */
  }
  check(
    "strings is the native CLI query, not a browser-specific command",
    strings.code === 0 && Array.isArray(stringsDocument.strings),
    `exit ${strings.code}, ${stringsDocument.strings?.length ?? 0} strings`,
  );

  const xrefs = host.run(["xrefs", ARCHIVE, "--to", "0x1000", "--json"], mounts);
  let xrefDocument: { target?: unknown } = {};
  try {
    xrefDocument = JSON.parse(xrefs.stdout) as typeof xrefDocument;
  } catch {
    /* reported below */
  }
  check(
    "xrefs accepts native CLI ordering and its query flags",
    xrefs.code === 0 && xrefDocument.target !== undefined,
    `exit ${xrefs.code}`,
  );

  const listing = host.run(["disassemble", ARCHIVE, "0x1000", "--count", "0x3", "--json"], mounts);
  let listingDocument: { instructions?: unknown[] } = {};
  try {
    listingDocument = JSON.parse(listing.stdout) as typeof listingDocument;
  } catch {
    /* reported below */
  }
  check(
    "disassemble accepts a bounded native CLI query and a hexadecimal count",
    listing.code === 0 && Array.isArray(listingDocument.instructions),
    `exit ${listing.code}, ${listingDocument.instructions?.length ?? 0} instructions`,
  );

  const raw = host.run(["read", ARCHIVE, "0x1000", "--bytes", "0x10", "--json"], mounts);
  let rawDocument: { hex?: string } = {};
  try {
    rawDocument = JSON.parse(raw.stdout) as typeof rawDocument;
  } catch {
    /* reported below */
  }
  check(
    "read accepts a hexadecimal byte count",
    raw.code === 0 && typeof rawDocument.hex === "string" && rawDocument.hex.length === 32,
    `exit ${raw.code}, ${rawDocument.hex?.length ?? 0} hex digits`,
  );

  const reversed = host.run(["read", "0x1000", ARCHIVE, "--bytes", "0x10", "--json"], mounts);
  check(
    "read repairs target-before-binary ordering",
    reversed.code === 0 && reversed.stdout.includes("\"start\": 4096"),
    `exit ${reversed.code}`,
  );

  let missingTargetRefused = false;
  try {
    host.run(["disassemble", ARCHIVE, "--count", "3", "--json"], mounts);
  } catch (error) {
    missingTargetRefused = String(error).includes("needs a function name, address, or address range");
  }
  check("disassemble rejects a missing target before guest execution", missingTargetRefused);

  let catalogRefused = false;
  try {
    host.run(["catalog", ARCHIVE, "--json"], mounts);
  } catch (error) {
    catalogRefused = String(error).includes("unavailable");
  }
  check(
    "catalog is refused: its native implementation needs a second executable",
    catalogRefused,
  );

  const target = names[0];
  if (target === undefined) {
    check("a function to decompile", false, "the inventory was empty");
  } else {
    const decompiled = host.run(["decompile", ARCHIVE, target, "--json"], mounts);
    let document: { functions?: { code?: string | null }[] } = {};
    try {
      document = JSON.parse(decompiled.stdout) as typeof document;
    } catch {
      /* reported below */
    }
    const code = (document.functions ?? []).map((entry) => entry.code ?? "").join("\n");
    check(
      "decompile returns C through native CLI argv",
      decompiled.code === 0 && code.includes(target) && code.includes("{"),
      `exit ${decompiled.code}, ${code.length} bytes of C`,
    );
  }

  // --------------------------------------------------------------- write policy

  for (const [label, args] of [
    ["project alias", ["project", ARCHIVE]],
    ["decompile-project", ["decompile-project", ARCHIVE]],
    ["output option", ["decompile-graph", ARCHIVE, "--output", "/work/out.json"]],
    ["spec override", ["functions", ARCHIVE, "--sleighpath", "/work/not-specs"]],
    ["worker option", ["decompile-all", ARCHIVE, "--jobs", "2"]],
  ] as const) {
    let refused = false;
    try {
      host.run(args, mounts);
    } catch {
      refused = true;
    }
    check(`${label} is refused before guest execution`, refused);
  }

  // -------------------------------------------------------------- through the sandbox

  const sandbox = new Sandbox(
    {
      functions: {
        kuna: (args): EngineOutcome => host.run(args.map((arg) => String(arg)), mounts),
      },
    },
    { deadlineMs: 60_000, memoryBytes: 512 << 20 },
  );

  const outcome = await sandbox.run(`
    const inventory = JSON.parse(kuna(['functions', '${ARCHIVE}', '--json']).stdout);
    const target = inventory.functions[0].name;
    let out = kuna(['decompile', '${ARCHIVE}', target, '--json']);
    if (out.code !== 0) out = kuna(['decompile', '${ARCHIVE}', target, '--json']);
    const first = JSON.parse(out.stdout).functions[0];
    return JSON.stringify({ count: inventory.count, target, c: first.code.slice(0, 60) });
  `);

  if (outcome.error === null && outcome.result !== null) {
    const summary = JSON.parse(outcome.result) as { count: number; target: string; c: string };
    check(
      "a run_js program sees the native CLI through kuna(args)",
      summary.count > 0 && summary.c.length > 0,
      `${summary.count} functions, ${summary.target}: ${summary.c.replaceAll("\n", " ").slice(0, 50)}`,
    );
  } else {
    check(
      "a run_js program sees the native CLI through kuna(args)",
      false,
      outcome.error ? `${outcome.error.name}: ${outcome.error.message}` : "no result",
    );
  }
  check("the engine call is counted", outcome.calls >= 2, `${outcome.calls} engine call(s), ${outcome.ms} ms`);
} finally {
  server.close();
}

if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log("\nall kuna checks passed");
