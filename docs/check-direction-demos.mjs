/**
 * Renders ui-direction-demos.html and checks that the four directions are what
 * the page claims: the same content, four different visual systems, with the
 * separation the page reports in its own measurement table.
 *
 * It starts its own static server, so it is one command from the repository root:
 *
 *   node docs/check-direction-demos.mjs
 *
 * Screenshots land in docs/.direction-demos/ for eyeballing. Environment:
 *   CHROME_PATH   Chrome binary, when it is not at the macOS default
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(docsDir);
const shotDir = resolve(docsDir, ".direction-demos");
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  return false;
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once("exit", done);
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => child.kill("SIGKILL"), 2000);
  });
}

const serverPort = await freePort();
const debugPort = await freePort();
const pageUrl = `http://localhost:${serverPort}/docs/ui-direction-demos.html`;

await mkdir(shotDir, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "repi-demo-"));

const server = spawn("python3", ["-m", "http.server", String(serverPort), "--directory", repoRoot], {
  stdio: "ignore",
  detached: true,
});
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1400,1000",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label} -> ${JSON.stringify(actual)}`);
};
const checkThat = (label, ok, detail) => {
  if (!ok) failures.push(`${label}: ${detail}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${detail}`);
};

let socket;
try {
  if (!(await waitFor(pageUrl))) throw new Error(`Static server never came up on ${pageUrl}`);

  let ws;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        break;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  socket = ws;
  await new Promise((done, fail) => {
    ws.addEventListener("open", done, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? "exception");
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`CDP ${method} did not answer within 30s`));
      }, 30000);
      pending.set(id, { resolve: done, reject: fail, method, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "page evaluation failed");
    }
    return result.result.value;
  };

  const shot = async (name) => {
    const result = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(shotDir, `${name}.png`), Buffer.from(result.data, "base64"));
  };

  /*
   * The frame is 820px tall and the viewport is 1000, so a plain capture cuts the
   * bottom off. Clipping to the frame gives one clean 1180x820 image per
   * direction, which is what the comparison is actually read from.
   */
  const shotFrame = async (name) => {
    const box = await evaluate(`(() => {
      const frame = document.querySelector(".frame");
      const rect = frame.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
    // The frame sits below the page header and is taller than the viewport, so the
    // capture has to be allowed past it; otherwise the bottom is page background.
    const result = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    });
    await writeFile(join(shotDir, `${name}.png`), Buffer.from(result.data, "base64"));
    return box;
  };

  const switchTo = async (view) => {
    await evaluate(`document.querySelector('.switcher button[data-view="${view}"]').click()`);
    await sleep(450);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url: pageUrl });
  await sleep(1200);

  // ---------------------------------------------------------------- four directions

  await switchTo("all");

  const all = await evaluate(`(() => {
    const dirs = [...document.querySelectorAll(".dir")];
    return {
      count: dirs.length,
      ids: dirs.map((dir) => dir.dataset.dir),
      frames: dirs.map((dir) => { const box = dir.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; }),
      codeLines: dirs.map((dir) => dir.querySelectorAll(".d-line").length),
      rowHeights: dirs.map((dir) => Math.round(dir.querySelector(".d-row").getBoundingClientRect().height)),
    };
  })()`);

  check("the four directions plus the labelled variant render", all.count, 5);
  check("labelled A B C D and the variant", all.ids, ["a", "b", "c", "d", "c"]);
  check(
    "exactly one frame admits it breaks a rule",
    await evaluate(`document.querySelectorAll('.dir[data-risk="true"]').length`),
    1,
  );
  check("every frame is 1180x820", all.frames.every(([w, h]) => w === 1180 && h === 820), true);
  check("every direction decompiles the same method", new Set(all.codeLines).size, 1);
  checkThat("row heights genuinely differ", new Set(all.rowHeights.slice(0, 4)).size >= 3, all.rowHeights.join(", "));
  await shot("all-four");

  // ---------------------------------------------------------------- identical content

  const content = await evaluate(`(() => {
    const signature = (dir) => JSON.stringify({
      file: dir.querySelector(".d-bar b").textContent,
      detail: dir.querySelector(".d-bar .d-file span").textContent,
      source: dir.querySelector(".d-source b").textContent,
      count: dir.querySelector(".d-count").textContent,
      tabs: [...dir.querySelectorAll(".d-tab")].map((tab) => tab.textContent),
      rows: [...dir.querySelectorAll(".d-row")].map((row) => [row.dataset.kind, row.querySelector(".d-row-label").textContent, row.dataset.open ?? ""]),
      title: dir.querySelector(".d-title b").textContent,
      meta: dir.querySelector(".d-title span.d-meta-line").textContent,
      code: [...dir.querySelectorAll(".d-line")].map((line) => line.textContent.replace(/^[0-9]+/, "")),
    });
    const signatures = [...document.querySelectorAll(".dir")].map(signature);
    return { unique: new Set(signatures).size, first: JSON.parse(signatures[0]).code[1] };
  })()`);

  check("content is identical across all four", content.unique, 1);
  checkThat("and it is a real method body", content.first.includes("authenticate"), content.first.slice(0, 60));

  // ---------------------------------------------------------------- measured separation

  const readout = await evaluate(
    `[...document.querySelectorAll("#readout tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent))`,
  );

  check("the readout covers every direction", readout.length, 5);
  const chromes = readout.map((row) => parseInt(row[1], 10));
  const rows = readout.map((row) => parseInt(row[2], 10));
  const bases = readout.map((row) => parseFloat(row[3]));
  checkThat("chrome spread is at least 40px", Math.max(...chromes) - Math.min(...chromes) >= 40, `${chromes.join(", ")}px`);
  checkThat("row height spread is at least 8px", Math.max(...rows) - Math.min(...rows) >= 8, `${rows.join(", ")}px`);
  checkThat("base font spread is at least 3px", Math.max(...bases) - Math.min(...bases) >= 3, `${bases.join(", ")}px`);
  console.log("    readout:", JSON.stringify(readout));

  // ---------------------------------------------------------------- the touch floor

  /*
   * The product rule is that every interactive target clears 44px. The comparison
   * is only useful if what it shows is buildable, so the four candidates are held
   * to it and the variant is required to be marked.
   */
  const targets = await evaluate(`(() => {
    const tooSmall = [];
    const measure = (dir, selector, label) => {
      for (const node of dir.querySelectorAll(selector)) {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        const smallest = Math.min(box.width, box.height);
        if (smallest < 44) tooSmall.push(dir.dataset.dir + " " + label + ":" + Math.round(smallest));
      }
    };
    for (const dir of document.querySelectorAll(".dir")) {
      if (dir.dataset.risk === "true") continue;
      measure(dir, ".d-row", "row");
      measure(dir, ".d-tab", "tab");
      measure(dir, ".d-mode button", "mode");
      measure(dir, ".d-source", "source");
      measure(dir, ".d-search", "filter");
    }
    for (const node of document.querySelectorAll(".switcher button")) {
      const box = node.getBoundingClientRect();
      if (Math.min(box.width, box.height) < 44) tooSmall.push("switcher:" + Math.round(box.height));
    }
    const variant = document.querySelector('.dir[data-risk="true"]');
    const variantRow = variant ? Math.round(variant.querySelector(".d-row").getBoundingClientRect().height) : null;
    return { tooSmall: [...new Set(tooSmall)], variantRow };
  })()`);

  checkThat("every control in the four candidates clears 44px", targets.tooSmall.length === 0, targets.tooSmall.join(", "));
  checkThat("the variant is the only thing below the floor", (targets.variantRow ?? 99) < 44, `variant row=${targets.variantRow}px`);

  // ---------------------------------------------------------------- divider treatment

  const rules = await evaluate(`(() => {
    const opaque = (value) => {
      if (!value || value === "transparent") return false;
      const parts = value.split(",");
      return parts.length < 4 ? true : parseFloat(parts[3]) > 0;
    };
    return [...document.querySelectorAll(".dir")].map((dir) => {
      let visible = 0;
      for (const child of dir.querySelector(".d-nav").children) {
        const style = getComputedStyle(child);
        if (parseFloat(style.borderBottomWidth) > 0 && opaque(style.borderBottomColor)) visible += 1;
      }
      return { id: dir.dataset.dir, visible };
    });
  })()`);

  checkThat("at least one direction drops dividers entirely", rules.some((entry) => entry.visible === 0), JSON.stringify(rules));
  checkThat("and at least one keeps them", rules.some((entry) => entry.visible >= 3), JSON.stringify(rules));

  // ---------------------------------------------------------------- interaction

  const interact = await evaluate(`(() => {
    const out = [];
    for (const dir of document.querySelectorAll(".dir")) {
      const id = dir.dataset.dir;
      const before = dir.querySelectorAll(".d-row").length;
      [...dir.querySelectorAll('.d-row[data-kind="package"][data-open="true"]')].pop()?.click();
      const collapsed = dir.querySelectorAll(".d-row").length;
      dir.querySelector('.d-row[data-key="com.example.notes.auth"]')?.click();
      const expanded = dir.querySelectorAll(".d-row").length;
      dir.querySelector('.d-row[data-key="onCreate"]')?.click();
      const selected = dir.querySelector('.d-row[aria-selected="true"]')?.dataset.key ?? null;
      dir.querySelector('.d-tab[data-tab="STRINGS"]')?.click();
      const tab = dir.querySelector('.d-tab[aria-pressed="true"]')?.dataset.tab ?? null;
      out.push({ id, before, collapsed, expanded, selected, tab });
    }
    return out;
  })()`);

  checkThat(
    "expand and collapse work in every direction",
    interact.every((entry) => entry.collapsed < entry.before && entry.expanded === entry.before),
    JSON.stringify(interact.map((entry) => [entry.id, entry.before, entry.collapsed, entry.expanded])),
  );
  checkThat("selection works in every direction", interact.every((entry) => entry.selected === "onCreate"), JSON.stringify(interact.map((entry) => [entry.id, entry.selected])));
  checkThat("tab switching works in every direction", interact.every((entry) => entry.tab === "STRINGS"), JSON.stringify(interact.map((entry) => [entry.id, entry.tab])));

  // ---------------------------------------------------------------- per direction

  for (const view of ["a", "b", "c", "d", "c-relaxed"]) {
    await switchTo(view);
    check(
      `direction ${view} renders alone`,
      await evaluate(`document.querySelector(".dir").dataset.dir`),
      view === "c-relaxed" ? "c" : view,
    );
    const box = await shotFrame(`direction-${view}`);
    check(
      `${view}: the screenshot covers the whole frame`,
      [Math.round(box.width), Math.round(box.height)],
      [1180, 820],
    );
  }

  // ---------------------------------------------------------------- invariants

  check("no console errors", consoleErrors, []);
  check(
    "no cross-origin requests",
    await evaluate(`performance.getEntriesByType("resource").every((entry) => new URL(entry.name).origin === location.origin)`),
    true,
  );
  check(
    "no external stylesheets, scripts or images",
    await evaluate(`document.querySelectorAll('link[rel="stylesheet"], script[src], img').length`),
    0,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  socket?.close();
  await stop(chrome);
  await stop(server);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

if (failures.length === 0) {
  console.log(`\nAll direction-demo checks passed. Screenshots in ${shotDir}`);
  process.exit(0);
}

console.error(`\n${failures.length} failure(s):`);
for (const failure of failures) console.error(`- ${failure}`);
process.exit(1);
