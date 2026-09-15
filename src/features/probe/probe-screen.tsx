/**
 * A one-click probe for the browser path, for development only.
 *
 * Everything the agent does in the browser goes through three things a Node check cannot
 * reach: a module Worker, `FileReaderSync` over a real `File`, and `fetch` for the engine and
 * its specs. This screen runs one canned program through all three and prints the outcome, so
 * a person can tell "the engine works in the browser" from "the model wrote bad JavaScript"
 * without spending a conversation on it.
 *
 *   npm run dev, then http://127.0.0.1:5173/?probe
 *   …or ?probe=<url> to fetch the binary instead of picking one.
 *
 * `?code=<base64>` runs a program of your own through the same path.
 *
 * It is behind `import.meta.env.DEV` and a dynamic import in `app.tsx`, so nothing of this
 * file is in a production bundle.
 */
import { createEffect, createSignal, Show } from "solid-js";
import { detectFormat } from "../../lib/detect-format";
import { mountedPath } from "../../lib/analysis/rasc/wasi";
import { openSandbox } from "../../lib/agent/sandbox";
import { createWorkspaceStorage } from "../../lib/storage/workspace-storage";
import type { SandboxOutcome } from "../../lib/agent/quickjs-sandbox";

/** The same store the conversations use, so a probe run and an agent run see one filesystem. */
const storage = createWorkspaceStorage();

/**
 * Both layers of an APK in one program, which is the thing neither engine can do alone.
 *
 * `kuna` here is not warm — the session started with rasc — so the first call is what makes
 * the host fetch and compile Kuna, and the program is then run again. This program is written
 * as if that never happened, which is the point.
 */
const apkProgram = (binary: string) => `
  const entries = rasc(['entries', '${binary}']).stdout.split('\\n');
  const libraries = entries
    .map((line) => line.split(' | ')[0].trim())
    .filter((name) => name.startsWith('lib/') && name.endsWith('.so'));
  const arm64 = libraries.filter((name) => name.includes('arm64-v8a'));
  print('native libraries: ' + libraries.length + ' (' + arm64.length + ' arm64-v8a)');

  const before = ls();
  const picked = extract(arm64[0] ?? libraries[0]);
  const listed = JSON.parse(kuna([picked.path, 'list']).stdout);
  const wanted = listed.functions.find((fn) => /JNI|Java_/.test(fn.name)) ?? listed.functions[0];
  const decompiled = JSON.parse(kuna([picked.path, 'decompile', wanted.name]).stdout);
  return JSON.stringify({
    tools: tools(),
    sandboxBefore: before.map((entry) => entry.path + ' (' + entry.bytes + 'B)'),
    picked: picked.path,
    bytes: picked.bytes,
    functions: listed.count,
    target: wanted.name,
    c: decompiled.functions[0].code.split('\\n').slice(0, 3).join(' | '),
  });
`;

/** Lists and decompiles: this is the path that needs a SLEIGH spec fetched on demand. */
const kunaProgram = (binary: string) => `
  const listed = JSON.parse(kuna(['${binary}', 'list']).stdout);   // the host re-runs this once if a spec has to be fetched
  const target = listed.functions[0].name;
  const decompiled = JSON.parse(kuna(['${binary}', 'decompile', target]).stdout);
  return JSON.stringify({ functions: listed.count, target, c: decompiled.functions[0].code.split('\\n')[0] });
`;

export function ProbeScreen() {
  const [lines, setLines] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);

  const [verdict, setVerdict] = createSignal<"running" | "ok" | "fail">("running");
  const say = (line: string) => {
    setLines((previous) => [...previous, line]);
  };
  // A headless run reads the title rather than parsing the page, so it says one of three
  // things and never "ok" merely because nothing has failed yet.
  createEffect(
    () => verdict(),
    (state) => {
      document.title = `probe: ${state}`;
    },
  );

  const run = async (file: File) => {
    setBusy(true);
    const started = performance.now();
    try {
      const format = await detectFormat(file);
      say(`${file.name}: ${format.label} (${(file.size / 1048576).toFixed(1)} MB) → warm ${format.engine ?? "none"}`);

      const params = new URLSearchParams(window.location.search);
      const encoded = params.get("code");
          const code = encoded
        ? atob(encoded)
        : format.engine === "kuna"
          ? kunaProgram(mountedPath(file.name))
          : apkProgram(mountedPath(file.name));

      // What earlier sessions produced, mounted read-only: the shared virtual filesystem.
      const derived = await storage.listDerived();
      const vfs = (
        await Promise.all(
          derived
            .filter((record): record is typeof record & { path: string } => record.path !== undefined)
            .map(async (record) => ({
              path: record.path,
              bytes: new Uint8Array(await (await storage.openFile(record.id)).arrayBuffer()),
            })),
        )
      );
      say(`sandbox files carried in: ${vfs.length}`);

      const sandbox = openSandbox(file, {
        ...(vfs.length > 0 ? { vfs } : {}),
        // Whatever the program produces is kept, under the path the sandbox knows it by.
        onProduced: (files) => {
          for (const produced of files) {
            void storage.saveDerived(produced.path, produced.bytes, "probe").catch(() => undefined);
          }
        },
        // Both, when both are here: the point of the probe is the path, not the format.
        engines: ["rasc", "kuna"],
        ...(format.engine ? { warm: format.engine } : {}),
        specRoot: new URL("kuna/specs", document.baseURI).href,
        smallBundleUrl: new URL("kuna/specs-small.json", document.baseURI).href,
      });
      say(`loading the ${format.engine} engine into a Worker…`);
      const outcome: SandboxOutcome = await sandbox.run(code);
      sandbox.close();

      if (outcome.error) {
        setVerdict("fail");
        say(`FAIL ${outcome.error.name}: ${outcome.error.message}`);
        if (outcome.error.stack) say(outcome.error.stack.split("\n").slice(0, 3).join("\n"));
      } else {
        setVerdict("ok");
        say(`ok   ${outcome.calls} engine call(s), ${outcome.ms} ms`);
        if (outcome.printed) say(`printed:\n${outcome.printed}`);
        if (outcome.result) say(`result:\n${outcome.result}`);
      }
      const kept = await storage.listDerived();
      say(`kept in the sandbox store: ${kept.length} — ${kept.map((record) => record.path ?? record.name).join(", ") || "nothing"}`);
      say(`total ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      setVerdict("fail");
      say(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  /*
   * Solid 2 splits `createEffect` into a compute half that tracks and an effect half that
   * runs: the compute half reads nothing, so the effect half runs once, after render — which
   * is what `onMount` was for.
   */
  createEffect(
    () => new URLSearchParams(window.location.search).get("probe"),
    (from) => {
    if (!from || from === "") return;
    say(`fetching ${from} …`);
    void fetch(from)
      .then(async (response) => {
        if (!response.ok) throw new Error(`that URL answered ${response.status}`);
        const blob = await response.blob();
        await run(new File([blob], from.split("/").pop() ?? "binary"));
      })
      .catch((error: unknown) => say(`FAIL ${error instanceof Error ? error.message : String(error)}`));
    },
  );

  return (
    <main style={{ "font-family": "ui-monospace, monospace", padding: "24px", "line-height": "1.5" }}>
      <h1 style={{ "font-size": "16px" }}>sandbox probe</h1>
      <p style={{ "max-width": "70ch", opacity: 0.8 }}>
        One canned program through the real path: a module Worker, <code>FileReaderSync</code> over a real
        file, the WASI host, and QuickJS. Development only — nothing here is in a production bundle.
      </p>
      <p>
        <input
          type="file"
          disabled={busy()}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void run(file);
          }}
        />
      </p>
      <pre style={{ "white-space": "pre-wrap", "max-width": "120ch" }}>{lines().join("\n")}</pre>
      <Show when={busy()}>
        <p>working…</p>
      </Show>
    </main>
  );
}
