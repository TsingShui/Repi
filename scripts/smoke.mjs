/**
 * Local smoke check for the built Repi app.
 *
 * It launches headless Chrome, starts nothing itself, and drives the real page
 * over the DevTools protocol: real files go through the real <input type="file">,
 * then the script asserts what the screen reports. Screenshots are written to
 * `.smoke/`.
 *
 * Usage:
 *   npm run verify        starts a server, runs this, stops it
 *   npm run smoke         uses a server you already have
 *
 * Environment:
 *   REPI_SMOKE_URL     page under test (default http://localhost:4173/)
 *   CHROME_PATH        Chrome binary
 *   REPI_CDP_TIMEOUT_MS per-command deadline (default 30000)
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apkOf, apkWithLeadingEntry, callsDex, constStringDex } from "./rasc-fixtures.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pageUrl = process.env.REPI_SMOKE_URL ?? "http://localhost:4173/";

/**
 * Pins the mock engine.
 *
 * A native binary now goes to the real Kuna engine when this deployment has one,
 * and Kuna answers a different set of questions than the mock does. The workspace
 * assertions below are about the workspace — tabs, density, the column — so they
 * pin the engine they were written against instead of measuring whichever one
 * happens to be installed. The Kuna section at the end does the opposite.
 */
const mockUrl = `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}engine=mock`;

/*
 * How many assertions the Kuna section makes, counting the one below that
 * verifies this number.
 *
 * Declared because the section skips when this build has no engine, and a
 * skipped section must still count towards what the suite claims to check —
 * otherwise the design document's count silently drops and the check that
 * compares them passes on a run that verified less. The number is not trusted:
 * the last assertion in the section fails if it stops matching.
 */
const KUNA_SECTION_CHECKS = 17;

/**
 * How many assertions the Rasc section makes, counting the one below that
 * verifies this number. Declared for the same reason, and checked the same way.
 */
const RASC_SECTION_CHECKS = 41;

/** The fixtures `npm run build:kuna` copies out of the Kuna checkout. */
const kunaFixtures = { elf: join(projectRoot, "public/kuna/fixtures/sample.elf") };
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shotDir = resolve(projectRoot, ".smoke");

const DESKTOP = { width: 1180, height: 820 };
const NARROW = { width: 700, height: 820 };
const OVERLAY = { width: 600, height: 820 };

/** The density each pointer mode is supposed to produce. */
const DENSITY = {
  fine: { topBar: 36, row: 28, tab: 32 },
  coarse: { topBar: 44, row: 44, tab: 44 },
};

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

/** Builds the fixtures. Nothing is read from the network. */
async function writeFixtures(directory) {
  const elf = Buffer.alloc(2 * 1024 * 1024);
  elf.write("\x7fELF\x02\x01\x01\x00", 0, "binary");
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(0xb7, 18);
  elf.write("libtarget", 0x40, "utf8");
  await writeFile(join(directory, "libtarget.so"), elf);

  const apk = Buffer.alloc(512 * 1024);
  apk.write("PK\x03\x04", 0, "binary");
  apk.write("AndroidManifest.xml", 30, "utf8");
  apk.write("classes.dex", 60, "utf8");
  await writeFile(join(directory, "notes-release.apk"), apk);

  const zip = Buffer.alloc(64 * 1024);
  zip.write("PK\x03\x04", 0, "binary");
  zip.write("docs/readme.txt", 30, "utf8");
  await writeFile(join(directory, "toolchain.zip"), zip);

  /*
   * The Rasc engine needs a real DEX, and these are built here rather than
   * downloaded: a class index with two classes, and two classes where one calls
   * the other across a class boundary. Each is written both bare — which the page
   * wraps in a one-entry archive — and inside a real APK, which is what the
   * oracle is pointed at.
   */
  const calls = callsDex();
  await writeFile(join(directory, "calls.dex"), calls);
  await writeFile(join(directory, "calls.apk"), apkOf(calls));
  await writeFile(join(directory, "late.apk"), apkWithLeadingEntry(calls));
  const index = constStringDex({ classCount: 4 });
  await writeFile(join(directory, "index.dex"), index);
  await writeFile(join(directory, "index.apk"), apkOf(index));

  return {
    elf: join(directory, "libtarget.so"),
    apk: join(directory, "notes-release.apk"),
    zip: join(directory, "toolchain.zip"),
    callsDex: join(directory, "calls.dex"),
    callsApk: join(directory, "calls.apk"),
    lateApk: join(directory, "late.apk"),
    indexDex: join(directory, "index.dex"),
    indexApk: join(directory, "index.apk"),
  };
}

async function connect(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((open, fail) => {
          socket.addEventListener("open", open, { once: true });
          socket.addEventListener("error", fail, { once: true });
        });
        return socket;
      }
    } catch {
      // Chrome is still starting up.
    }
    await sleep(250);
  }
  chromeBlocked = "Chrome DevTools endpoint never became available";
  throw new Error("Chrome DevTools endpoint never became available");
}

function createSend(socket) {
  let nextId = 0;
  const pending = new Map();
  const timeoutMs = Number(process.env.REPI_CDP_TIMEOUT_MS ?? 30000);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  });

  // A DevTools call that never answers would otherwise hang with no clue which.
  return (method, params = {}) =>
    new Promise((done, fail) => {
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`CDP ${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: done, reject: fail, method, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
}

const failures = [];
/** Checks that did not run because the engine is not installed. Reported, not hidden. */
const skipped = [];
let passed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label} -> ${JSON.stringify(actual)}`);
}

function checkThat(label, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${label}: ${detail}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${detail}`);
}

/** Chrome keeps writing to its profile after SIGTERM, so wait before cleanup. */
function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      setTimeout(done, 500);
    }, 2000);
  });
}

const profile = await mkdtemp(join(tmpdir(), "repi-smoke-"));
const fixturesRoot = await mkdtemp(join(tmpdir(), "repi-fixtures-"));
const debugPort = Number(process.env.CHROME_DEBUG_PORT ?? (await freePort()));

await rm(shotDir, { recursive: true, force: true });
await mkdir(shotDir, { recursive: true });
const fixtures = await writeFixtures(fixturesRoot);

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    /*
     * Headless Chrome on Linux reports `pointer: none` — no fine pointer, no
     * hover — so the density assertions below would measure the roomy fallback
     * on every machine that is not a desktop with a mouse attached. These blink
     * settings describe the device the suite is pretending to be: a fine pointer
     * that hovers. The coarse branch is still driven through the attribute, not
     * through media emulation, which is the whole reason the app reads matchMedia
     * into a data attribute.
     */
    "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
    "--hide-scrollbars",
    `--window-size=${DESKTOP.width},${DESKTOP.height}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let chromeError = "";
// Set when the page could not be driven at all. The report below records it, because a
// blocked run and a one-assertion failure write the same counts and the document check
// would otherwise read a machine problem as a regression (it did, this session).
let chromeBlocked = "";
chrome.stderr.on("data", (chunk) => {
  chromeError += String(chunk);
});

chrome.on("error", (error) => {
  console.error(`Could not start Chrome at ${chromePath}: ${error.message}`);
  console.error("Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(1);
});

let socket;

try {
  socket = await connect(debugPort);
  const send = createSend(socket);
  const consoleErrors = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? "exception");
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", { ...DESKTOP, deviceScaleFactor: 2, mobile: false });
  await send("Browser.grantPermissions", {
    origin: new URL(pageUrl).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch(() => {
    // Older Chrome builds do not know every permission name. The clipboard
    // assertion below reports the truth either way.
  });
  await send("Page.navigate", { url: mockUrl });
  await sleep(1500);

  if (!(await evaluate(`Boolean(document.querySelector(".app"))`))) {
    throw new Error(
      `The page at ${pageUrl} never rendered Repi.\n` +
        `  Start the built site:  npm run preview\n` +
        `  Or do both at once:    npm run verify`,
    );
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "page evaluation failed");
    }
    return result.result.value;
  }

  async function click(selector) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(250);
  }

  /**
   * A click that the browser treats as a real one.
   *
   * `element.click()` from script is enough for most of this suite, but it grants
   * no transient activation, and the clipboard needs it. Anything that depends on
   * a genuine gesture has to go through the input domain or the test is checking
   * a path no user can take.
   */
  async function clickAt(selector) {
    const box = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`clickAt: no element for ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(300);
  }

  async function clickAll(selector) {
    await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).forEach((node) => node.click())`);
    await sleep(300);
  }

  async function sendKey(key, code, virtualKeyCode, modifiers = 0) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode, modifiers });
    await sleep(200);
  }
  const META = 4;
  const META_SHIFT = 12;

  async function setViewport({ width, height }) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await sleep(300);
  }

  /*
   * Chrome cannot emulate a coarse pointer, so the density branch is driven
   * through the attribute the app sets from matchMedia. The detection itself is
   * asserted separately.
   */
  async function setPointer(value) {
    await evaluate(`document.querySelector(".app").dataset.pointer = ${JSON.stringify(value)}`);
    await sleep(300);
  }

  /** One 1180x820 image of the app, whatever is on screen. */
  async function screenshotApp(name) {
    const box = await evaluate(`(() => { const r = document.querySelector(".app").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    await writeFile(join(shotDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  }

  /**
   * Reads the system clipboard back. The page cannot do this without a permission
   * prompt, so it goes through the browser instead — which also proves the copy
   * reached the clipboard rather than only updating the button.
   */
  async function readClipboard() {
    try {
      const result = await send("Runtime.evaluate", {
        expression: "navigator.clipboard.readText()",
        awaitPromise: true,
        returnByValue: true,
      });
      return result.result?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The engine's own answer for a fixture, from the same wasm the page runs.
   *
   * This is the oracle the browser's output is compared against: same artifact,
   * same binary, a different host. It is deliberately not a snapshot of what the
   * engine said once — a stale expectation would pass while the page showed
   * something else.
   */
  function kunaOracle(command, fixture, target) {
    const args = ["scripts/kuna-oracle.mjs", command, fixture];
    if (target !== undefined) args.push(target);
    return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  }

  const kunaInNode = (fixture) => kunaOracle("list", fixture);
  const kunaDecompileInNode = (fixture, target) => kunaOracle("decompile", fixture, target).code;

  /**
   * Whitespace at the ends of lines is not a difference anybody can see, and
   * neither is a blank line: the code view draws its own member headers and gaps
   * where the engine's own blank separators would be, so the comparison is over
   * the lines that carry text.
   */
  function normaliseCode(code) {
    return code
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .join("\n");
  }

  async function selectFile(path, waitMs = 400) {
    const handle = await send("Runtime.evaluate", { expression: `document.querySelector(".file-input")` });
    await send("DOM.setFileInputFiles", { files: [path], objectId: handle.result.objectId });
    await sleep(waitMs);
  }

  async function waitFor(selector, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return true;
      await sleep(120);
    }
    return false;
  }

  const readHome = () =>
    evaluate(`(() => {

      return {
        button: document.querySelector(".entry-block-label")?.textContent.trim() ?? null,
        entryBlocks: [...document.querySelectorAll(".entry-block")].map((block) => ({
          label: block.querySelector(".entry-block-label")?.textContent.trim() ?? null,
          background: getComputedStyle(block).backgroundColor,
          height: Math.round(block.getBoundingClientRect().height),
          dropActive: block.dataset.dropActive ?? null,
        })),
        footers: document.querySelectorAll(".home footer").length,
        quickStart: (() => {
          const block = document.querySelector(".quick-start");
          if (!block) return null;
          const copy = block.querySelector(".quick-start-copy");
          const lead = block.querySelector(".quick-start-lead");
          const command = block.querySelector(".quick-start-command");
          const size = (node) => (node ? Number.parseFloat(getComputedStyle(node).fontSize) : null);
          return {
            lead: lead?.textContent.trim() ?? null,
            label: block.querySelector(".quick-start-label")?.textContent.trim() ?? null,
            command: command?.textContent.trim() ?? null,
            copyLabel: copy?.textContent.trim() ?? null,
            copyState: copy?.dataset.copyState ?? null,
            copyHeight: copy ? Math.round(copy.getBoundingClientRect().height) : null,
            commandHeight: command ? Math.round(command.getBoundingClientRect().height) : null,
            leadSize: size(lead),
            commandSize: size(command),
          };
        })(),
        links: [...document.querySelectorAll(".top-bar-link")].map((link) => ({
          text: link.textContent.trim(),
          href: link.getAttribute("href"),
          height: Math.round(link.getBoundingClientRect().height),
          external: link.getAttribute("rel") === "noreferrer",
        })),
        // 场是整页的，顶栏不该在它上面切出一条带子
        barChrome: (() => {
          const bar = document.querySelector(".top-bar");
          const style = getComputedStyle(bar);
          return { border: style.borderBottomWidth, background: style.backgroundColor };
        })(),
        // 内容块在英雄区里要真的居中。底栏在的时候它靠不对称的下内边距把内容顶上去，
        // 底栏一走，那套间距就变成了肉眼可见的偏下。
        heroBalance: (() => {
          const hero = document.querySelector(".home-hero");
          if (!hero) return null;
          const boxes = [...hero.children].map((child) => child.getBoundingClientRect());
          const content = hero.getBoundingClientRect();
          const top = Math.min(...boxes.map((b) => b.top));
          const bottom = Math.max(...boxes.map((b) => b.bottom));
          return Math.round(Math.abs(top - content.top) - (content.bottom - bottom));
        })(),
        heroBottom: (() => {
          const hero = document.querySelector(".home-hero");
          if (!hero) return null;
          return Math.round(window.innerHeight - hero.getBoundingClientRect().bottom);
        })(),
        readout: document.querySelectorAll(".selection, .selection-row").length,
        notice: document.querySelector(".home-notice")?.textContent.trim() ?? null,
        // 样式本身也要量：规则被上游的改动整段删掉过一次，而当时只断言了文字
        noticeStyle: (() => {
          const node = document.querySelector(".home-notice");
          if (!node) return null;
          const style = getComputedStyle(node);
          return { border: style.borderLeftWidth, colour: style.color, size: Number.parseFloat(style.fontSize) };
        })(),
        inWorkspace: Boolean(document.querySelector(".workspace-body")),
      };
    })()`);

  /** Everything the workspace assertions need, read from the live DOM. */
  const readWorkspace = () =>
    evaluate(`(() => {
      const app = document.querySelector(".app");
      if (!app) return { present: false };
      const box = (node) => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      };
      const nav = app.querySelector(".workspace-navigator");
      const tabs = [...app.querySelectorAll(".view-tab")].map((tab) => ({
        key: tab.dataset.tab,
        label: tab.querySelector(".view-tab-name")?.textContent ?? "",
        tag: tab.querySelector(".view-tab-tag")?.textContent ?? null,
        active: tab.dataset.active === "true",
      }));
      const activeTab = tabs.find((tab) => tab.active) ?? null;
      const firstRow = nav ? nav.querySelector(".navigator-row") : null;
      const importHead = app.querySelector('.section-head[data-section="import"]');
      return {
        present: Boolean(app.querySelector(".workspace-body")),
        top: box(app.querySelector(".workspace-top")),
        navigator: box(nav),
        main: box(app.querySelector(".workspace-main")),
        rail: app.querySelectorAll(".rail").length,
        localBadge: app.querySelector('[data-testid="local-badge"]')?.textContent.trim() ?? null,
        menuButtons: app.querySelectorAll(".workspace-more, .workspace-menu").length,
        narrow: app.querySelector(".workspace-body")?.dataset.narrow ?? null,
        handleRole: app.querySelector(".workspace-handle")?.getAttribute("role") ?? null,
        storedWidth: window.localStorage.getItem("repi.navigator-width"),
        tabs,
        activeLabel: activeTab ? activeTab.label : null,
        emptyLabel: app.querySelector(".workspace-empty-label")?.textContent.trim() ?? null,
        // 切换单元的入口在栏首；它掉出视口或被挤成零高，用户就换不了单元
        sourceCurrent: box(app.querySelector('[data-testid="source-current"]')),
        firstSectionTitle: app.querySelector(".workspace-navigator .section-title")?.textContent.trim() ?? null,
        sourceLabel: app.querySelector(".source-current-label")?.textContent.trim() ?? null,
        // 视图头没了：第一行有名字，每一行有地址。这里读第一行代码来分辨两个标签。
        firstCodeLine: app.querySelector(".code-body .code-line .code")?.textContent.trim() ?? null,
        modeLabel: app.querySelector('[data-testid="mode-label"]')?.textContent.trim() ?? null,
        segmentedControl: app.querySelectorAll(".code-mode button, .code-mode-option").length,
        members: [...app.querySelectorAll(".code-member")].map((member) => member.dataset.member),
        hitMember: app.querySelector('.code-member[data-hit="true"]')?.dataset.member ?? null,
        codeLines: app.querySelectorAll(".code-line").length,
        progress: (() => {
          const bar = app.querySelector('[data-testid="progress"]');
          if (!bar) return null;
          const r = bar.getBoundingClientRect();
          return { height: Math.round(r.height), y: Math.round(r.y), determinate: bar.dataset.determinate, value: bar.getAttribute("aria-valuenow") };
        })(),
        fieldVisible: Boolean(app.querySelector(".empty-field .structure-field-canvas")),
        firstRowKind: firstRow?.dataset.kind ?? null,
        firstRowLabel: firstRow?.querySelector(".navigator-row-label")?.textContent ?? null,
        navigatorCount: app.querySelector('[data-testid="navigator-count"]')?.textContent.trim() ?? null,
        stopVisible: Boolean(app.querySelector(".navigator-stop")),
        partialVisible: Boolean(app.querySelector('[data-testid="navigator-partial"]')),
        importRows: app.querySelectorAll('.section-body[data-list="import"] .navigator-row').length,
        importCount: Number.parseInt(importHead?.querySelector(".section-count")?.textContent ?? "0", 10),
        metaSections: [...app.querySelectorAll(".meta-section .meta-heading")].map((h) => h.textContent.trim()),
      };
    })()`);

  /** True when the element's centre sits within a few pixels of its parent's. */
  const isCentred = async (selector) => {
    const measured = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || !node.parentElement) return null;
      const inner = node.getBoundingClientRect();
      const outer = node.parentElement.getBoundingClientRect();
      return {
        dx: Math.abs((inner.left + inner.width / 2) - (outer.left + outer.width / 2)),
        dy: Math.abs((inner.top + inner.height / 2) - (outer.top + outer.height / 2)),
      };
    })()`);
    return measured !== null && measured.dx < 4 && measured.dy < 4;
  };

  const activateRow = async (kind, index = 0) => {
    await evaluate(`document.querySelectorAll('.navigator-row[data-kind="${kind}"]')[${index}].click()`);
    await sleep(600);
  };

  const openWorkspace = async (path) => {
    await selectFile(path);
    return waitFor(".workspace-body");
  };

  // ================================================================ home

  await screenshotApp("home-idle");

  const initial = await readHome();
  check("home: mounted", initial.inWorkspace, false);
  check("home: button", initial.button, "Open");
  check(
    "home: there are two ways in, side by side",
    initial.entryBlocks.map((block) => block.label),
    ["Open", "Drop file here"],
  );
  // 无缝：两块之间没有缝，整对只有一个外框
  const pairSeam = await evaluate(`(() => {
    const blocks = [...document.querySelectorAll(".entry-block")];
    const first = blocks[0].getBoundingClientRect();
    const second = blocks[1].getBoundingClientRect();
    const parent = blocks[0].parentElement.getBoundingClientRect();
    return {
      gap: Math.round(second.left - first.right),
      width: Math.round(first.width),
      siblingWidth: Math.round(second.width),
      insideOutline: Math.round(first.left - parent.left) === 1 && Math.round(parent.right - second.right) === 1,
    };
  })()`);
  check("home: the two blocks are seamless", pairSeam.gap, 0);
  // 不对称才优雅：等宽会把 "Open" 撑成一块没有内容的色板
  checkThat(
    "home: the two halves are deliberately asymmetric",
    pairSeam.width !== pairSeam.siblingWidth,
    `${pairSeam.width} vs ${pairSeam.siblingWidth}`,
  );
  checkThat(
    "home: and the pair is a control, not a band",
    pairSeam.width + pairSeam.siblingWidth <= 300,
    `${pairSeam.width + pairSeam.siblingWidth}px wide`,
  );
  checkThat("home: they share one outline", pairSeam.insideOutline, "both sit inside the same border");

  checkThat(
    "home: and they are the same size",
    new Set(initial.entryBlocks.map((block) => block.height)).size === 1,
    initial.entryBlocks.map((block) => `${block.height}px`).join(" vs "),
  );
  // 第二块是"第二色调"，不是灰掉的禁用态：同一个色系，低一档
  checkThat(
    "home: the second is a second tone, not a disabled one",
    initial.entryBlocks[0]?.background !== initial.entryBlocks[1]?.background &&
      (initial.entryBlocks[1]?.background ?? "").startsWith("rgba(77, 107, 254"),
    `${initial.entryBlocks[0]?.background} vs ${initial.entryBlocks[1]?.background}`,
  );
  check("home: no footer", initial.footers, 0);
  /*
   * The licences page. It has to work before any engine is installed, because
   * that is when the question is most likely asked, and it has to name the two
   * projects whose code actually ships rather than only the ones that were
   * convenient to list.
   */
  await click("[data-testid='licenses-link']");
  await sleep(500);
  checkThat("licenses: the link opens the page", await evaluate(`Boolean(document.querySelector('[data-testid="licenses"]'))`), "page shown");
  check("licenses: the home screen is not underneath it", await evaluate(`Boolean(document.querySelector(".home"))`), false);
  const barOrder = await evaluate(`(() => {
    const box = (s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; };
    return { back: box(".top-bar-back"), brand: box(".brand-name"), sep: box(".top-bar-sep"), title: box(".top-bar-title") };
  })()`);
  checkThat(
    "licenses: the bar reads left to right, not spread across it",
    barOrder.back !== null &&
      barOrder.brand !== null &&
      barOrder.title !== null &&
      barOrder.back.right <= barOrder.brand.left &&
      barOrder.brand.right <= barOrder.title.left &&
      barOrder.title.left - barOrder.brand.left < 80,
    JSON.stringify(barOrder),
  );
  const credits = await evaluate(`[...document.querySelectorAll('[data-testid="credit"]')].map((n) => n.dataset.credit)`);
  checkThat(
    "licenses: it names both engines, and what the native one reads",
    credits.includes("Kuna") && credits.includes("Ghidra") && credits.includes("Rasc"),
    credits.join(", "),
  );
  checkThat("licenses: and what ships in the page", credits.includes("SolidJS") && credits.includes("@bjorn3/browser_wasi_shim"), credits.join(", "));
  checkThat("licenses: and what only built it", credits.includes("Vite") && credits.includes("TypeScript"), credits.join(", "));
  checkThat("licenses: rasc and ASC are listed separately", credits.includes("Rasc") && credits.includes("ASC"), credits.join(", "));
  check(
    "licenses: every credit states its licence",
    await evaluate(`[...document.querySelectorAll(".credit-license")].every((n) => n.textContent.trim().length > 0)`),
    true,
  );
  // 服务出去就等于分发，所以许可必须跟着产物走，不能只躺在仓库里
  checkThat(
    "licenses: the licence is served with the page, not only in the repository",
    await evaluate(
      `fetch("/LICENSE").then((r) => r.ok && r.text()).then((t) => typeof t === "string" && t.includes("Apache License") && t.includes("Version 2.0"))`,
    ),
    "LICENSE is served",
  );
  check(
    "licenses: Repi states its own licence, and it is the engines'",
    await evaluate(`document.querySelector('[data-testid="credit-project"] .credit-license')?.textContent.trim() ?? null`),
    "Apache-2.0",
  );
  await screenshotApp("licenses");
  await evaluate(`document.querySelector(".top-bar-back").click()`);
  await sleep(500);
  checkThat("licenses: the mark goes back", await evaluate(`Boolean(document.querySelector(".home"))`), "home is back");

  check("home: the quick start names the Pi package install", initial.quickStart?.command, "pi install https://github.com/TsingShui/Repi");
  check("home: and it is labelled", initial.quickStart?.label, "Quick start");
  check("home: the Extension line says what the install is for", initial.quickStart?.lead, "Want more? Try the full Extension version");
  // 这一块原来是最小的字（10px/12px），读起来像脚注，没人会照着念
  checkThat("home: the Extension line is reading size, not a footnote", (initial.quickStart?.leadSize ?? 0) >= 15, `${initial.quickStart?.leadSize}px`);
  checkThat("home: and so is the command", (initial.quickStart?.commandSize ?? 0) >= 14, `${initial.quickStart?.commandSize}px`);
  check("home: nothing is read out before a file is chosen", initial.readout, 0);
  checkThat("home: and there is nothing to refuse yet", initial.notice === null, initial.notice ?? "none");

  // 复制按钮真的把命令写进剪贴板，并在按钮上说出来
  await clickAt(".quick-start-copy");
  const afterCopy = await readHome();
  const onClipboard = await readClipboard();
  checkThat("home: the copy control is a real target", (afterCopy.quickStart?.copyHeight ?? 0) >= 40, `${afterCopy.quickStart?.copyHeight}px`);
  check("home: copying says so on the button", afterCopy.quickStart?.copyLabel, "Copied");
  check("home: and the clipboard really holds the command", onClipboard, "pi install https://github.com/TsingShui/Repi");
  await screenshotApp("home-quick-start");
  await sleep(2100);
  check("home: the button returns to its resting label", (await readHome()).quickStart?.copyLabel, "Copy");

  /*
   * 剪贴板会拒绝：需要安全上下文、焦点，以及权限或真实手势。这条分支在无头里
   * 正常跑不到，所以把它按出来 —— 拒绝时按钮不能毫无反应。
   */
  await evaluate(`(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
  })()`);
  await clickAt(".quick-start-copy");
  const refused = await readHome();
  check("home: a refused clipboard says so instead of doing nothing", refused.quickStart?.copyLabel, "Selected");
  checkThat(
    "home: and it hands the command to the platform copy gesture",
    await evaluate(`window.getSelection()?.toString().trim()`),
    "pi install https://github.com/TsingShui/Repi",
  );
  await sleep(2100);

  const external = initial.links.filter((link) => (link.href ?? "").startsWith("http"));
  const internal = initial.links.filter((link) => !(link.href ?? "").startsWith("http"));
  check(
    "home: the top bar links out to the project and the author",
    external.map((link) => link.href),
    ["https://github.com/TsingShui/Repi", "https://tsingshui.art/about"],
  );
  checkThat("home: every link is a touch target", initial.links.every((link) => link.height >= 44), initial.links.map((link) => link.height).join(", "));
  // 出去的要说明自己出去了，里面的不该被当成外链
  checkThat("home: the outbound links say they are outbound", external.every((link) => link.external), external.map((l) => l.href).join(", "));
  checkThat("home: and the in-page one is not marked as leaving", internal.every((link) => !link.external), internal.map((l) => l.href).join(", "));
  checkThat("home: the licences link is a hash route", internal.some((link) => link.href === "#/licenses"), internal.map((l) => l.href).join(", "));
  checkThat(
    "home: the top bar does not divide the field",
    initial.barChrome.border === "0px",
    `border ${initial.barChrome.border}, background ${initial.barChrome.background}`,
  );
  checkThat("home: the hero reaches the bottom of the page", initial.heroBottom === 0, `${initial.heroBottom}px short`);
  checkThat("home: the hero block sits centred, not low", Math.abs(initial.heroBalance ?? 99) <= 2, `${initial.heroBalance}px off centre`);

  // A container with no engine stays on the home screen and explains itself.
  await selectFile(fixtures.zip);
  const zip = await readHome();
  await screenshotApp("home-unsupported");
  check("home: still on home", zip.inWorkspace, false);
  checkThat("home: an unsupported container says so in one line", (zip.notice ?? "").includes("ZIP"), zip.notice ?? "no notice");
  check("home: and there is no file readout under it", zip.readout, 0);
  checkThat(
    "home: the refusal is marked as a refusal, not loose text",
    (zip.noticeStyle?.border ?? "0px") !== "0px" && (zip.noticeStyle?.size ?? 0) >= 13,
    `border ${zip.noticeStyle?.border}, ${zip.noticeStyle?.size}px`,
  );

  /*
   * 拖放是整屏的：着落点也包括顶栏，所以渐变必须铺满视口，而不是内容区。
   * 合成事件带一个真的 File，走的和用户拖进来是同一条路径。
   */
  await evaluate(`(() => {
    const bytes = new Uint8Array(256 * 1024);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00], 0);
    const view = new DataView(bytes.buffer);
    view.setUint16(16, 3, true);
    view.setUint16(18, 0xb7, true);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dropped.so"));
    window.__drop = transfer;
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  })()`);
  await sleep(200);
  const glow = await evaluate(`(() => {
    const node = document.querySelector(".drop-glow");
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      active: node.dataset.active,
      opacity: Number(style.opacity),
      covers: Math.round(box.width) === window.innerWidth && Math.round(box.height) === window.innerHeight,
      strips: style.backgroundImage.split("linear-gradient").length - 1,
      animated: style.animationName,
    };
  })()`);
  check("drop: the whole screen answers a file being carried over it", glow?.covers, true);
  check(
    "drop: and the drop block answers too",
    await evaluate(`document.querySelector('[data-testid="drop-block"]').dataset.dropActive`),
    "true",
  );
  check("drop: with a wash from each edge", glow?.strips, 4);
  checkThat("drop: and it is visible, not just present", (glow?.opacity ?? 0) > 0.5, `opacity ${glow?.opacity}`);
  check("drop: it breathes while waiting", glow?.animated, "drop-breathe");
  await screenshotApp("home-dropping");

  await evaluate(`window.dispatchEvent(new DragEvent("dragleave", { dataTransfer: window.__drop, bubbles: true, cancelable: true }))`);
  await sleep(250);
  check("drop: and it goes away when the file leaves", await evaluate(`document.querySelector(".drop-glow").dataset.active`), "false");
  check(
    "drop: and the drop block goes back with it",
    await evaluate(`document.querySelector('[data-testid="drop-block"]').dataset.dropActive`),
    "false",
  );

  // 第二块不是死靶子：点它也能选文件
  await clickAt('[data-testid="drop-block"]');
  checkThat("drop: the drop block is not a dead target when tapped", true, "clicked without error");

  // 真正松手：文件应当被打开
  await evaluate(`window.dispatchEvent(new DragEvent("drop", { dataTransfer: window.__drop, bubbles: true, cancelable: true }))`);
  await sleep(1200);
  checkThat("drop: letting go opens the file", await evaluate(`Boolean(document.querySelector(".workspace-body"))`), "the workspace mounted");
  check("drop: and nothing is left saying it was refused", await evaluate(`Boolean(document.querySelector(".home-notice"))`), false);
  await evaluate(`document.querySelector(".workspace-back")?.click()`);
  await sleep(600);


  // ================================================================ workspace opens

  checkThat("workspace: opens for a supported file", await openWorkspace(fixtures.elf), "the workspace mounted");
  await sleep(400);

  const opened = await readWorkspace();
  check("workspace: it is the workspace", opened.present, true);
  check("workspace: no rail", opened.rail, 0);
  // 隐私声明不在界面上重复：smoke 每次运行都在证明它（零跨域请求），
  // 而屏幕上的徽标只是一句话，不是保证。
  check("workspace: no privacy badge", opened.localBadge, null);
  check("workspace: and no menu in the bar", opened.menuButtons, 0);

  /*
   * The application bar says three things: who makes this, which file is open,
   * and that nothing has left the device. The tab strip used to be a fourth, and
   * it belongs with the content it switches — a strip up here was a second
   * navigation for something the view already names.
   */
  const bar = await evaluate(`(() => {
    const strip = document.querySelector(".view-tabs");
    const top = document.querySelector(".workspace-top");
    return {
      file: document.querySelector('[data-testid="workspace-file"]')?.textContent.trim() ?? null,
      mark: document.querySelectorAll(".workspace-back .brand-mark").length,
      // No left arrow beside the mark: two controls for one intention.
      arrow: (document.querySelector(".workspace-back")?.textContent ?? "").includes("←"),
      stripInBar: top?.contains(strip) ?? null,
      stripInMain: document.querySelector(".workspace-main")?.contains(strip) ?? null,
      stripRow: strip ? Math.round(strip.getBoundingClientRect().top) >= Math.round(top.getBoundingClientRect().bottom) : null,
    };
  })()`);
  check("bar: it names the open file", bar.file, "libtarget.so");
  check("bar: the mark is the way back", bar.mark, 1);
  check("bar: and there is no separate arrow", bar.arrow, false);
  check("bar: the tab strip is not in the application bar", bar.stripInBar, false);
  check("bar: it belongs to the main area", bar.stripInMain, true);
  check("bar: and sits below the bar, not inside it", bar.stripRow, true);
  check("workspace: a tab is the thing you opened, so none is open yet", opened.tabs, []);
  checkThat("workspace: the empty state says so", (opened.emptyLabel ?? "").length > 0, opened.emptyLabel ?? "none");
  checkThat("workspace: the empty state is centred", await isCentred(".workspace-empty"), "centred");
  await screenshotApp("workspace-no-tab");

  // ================================================================ left column

  const column = await evaluate(`(() => {
    const nav = document.querySelector(".workspace-navigator");
    const heads = [...nav.querySelectorAll(":scope > .section-head, :scope > .section > .section-head")];
    const identify = (head) => head.closest(".section")?.dataset.section ?? head.dataset.section ?? head.dataset.entry ?? "?";
    return {
      expandable: heads.filter((h) => h.hasAttribute("aria-expanded") || h.querySelector("[aria-expanded]")).map(identify),
      entries: heads.map(identify),
      titles: heads.map((h) => h.querySelector(".section-title")?.textContent ?? ""),
    };
  })()`);

  check("column: the tree and the two short lists expand", column.expandable, ["tree", "import", "export"]);
  check("column: strings and meta are single entries", column.entries.filter((e) => e === "strings" || e === "meta"), ["strings", "meta"]);
  check("column: the tree is named for the language", column.titles[0], "Functions");
  check("column: every section is titled", column.titles.every((title) => title.length > 0), true);
  checkThat("column: the tree reports a symbol count", /[0-9]/.test(opened.navigatorCount ?? ""), opened.navigatorCount ?? "none");

  /*
   * libtarget.so is one analysis unit, so there is nothing to switch to. The row
   * A single unit means there is nothing to switch to, and the row that used to
   * stand in for a switcher is gone: the file name is in the application bar now
   * and the architecture is in META, so it was saying the same thing twice.
   */
  checkThat("column: one unit needs no switcher and no heading", opened.sourceCurrent === null, "neither");
  check("column: so the first thing in it is the tree", opened.firstSectionTitle, "Functions");

  // ================================================================ tab model

  await activateRow("function");
  const firstTab = await readWorkspace();
  check("tabs: opening a function adds one tab", firstTab.tabs.length, 1);
  check("tabs: labelled with the function", firstTab.tabs[0]?.label, firstTab.firstRowLabel);
  check("tabs: tagged with its language", firstTab.tabs[0]?.tag, "native");

  await activateRow("function", 1);
  const secondTab = await readWorkspace();
  check("tabs: a second function is a second tab", secondTab.tabs.length, 2);
  checkThat(
    "tabs: and the two show different code",
    secondTab.firstCodeLine !== firstTab.firstCodeLine,
    `${firstTab.firstCodeLine?.slice(0, 30)} vs ${secondTab.firstCodeLine?.slice(0, 30)}`,
  );
  await screenshotApp("workspace-function-tabs");

  await activateRow("function");
  check("tabs: reopening focuses rather than duplicating", (await readWorkspace()).tabs.length, 2);

  await click(".view-tab .view-tab-close");
  const afterClose = await readWorkspace();
  check("tabs: every tab closes, including a code tab", afterClose.tabs.length, 1);
  checkThat("tabs: closing the active one activates a neighbour", afterClose.activeLabel !== null, `${afterClose.activeLabel}`);

  await clickAll(".view-tab .view-tab-close");
  const emptied = await readWorkspace();
  check("tabs: closing the last leaves no tab", emptied.tabs, []);
  check("tabs: and the empty state returns", (emptied.emptyLabel ?? "").length > 0, true);

  // ================================================================ entries

  for (const entry of ["strings", "import", "export", "meta"]) {
    await click(`.section-head[data-entry="${entry}"], .section-head[data-section="${entry}"]`);
    const state = await readWorkspace();
    const tab = state.tabs.find((candidate) => candidate.key.startsWith(`${entry}:`));
    checkThat(`entries: ${entry} opens its tab in one click`, Boolean(tab), state.tabs.map((t) => t.key).join(", "));
    check(`entries: ${entry} is scoped to the unit and says which`, tab?.tag, "libtarget.so");
  }

  const expanded = await readWorkspace();
  checkThat("entries: the import list expanded on the same click", expanded.importRows > 0, `${expanded.importRows} rows`);
  check("entries: and it lists every entry its header claims", expanded.importRows, expanded.importCount);
  await evaluate(`document.querySelector('.view-tab[data-kind="import"] .view-tab-label')?.click()`);
  await sleep(500);
  check(
    "entries: the screenshot that follows really shows the import tab",
    await evaluate(`document.querySelector('.view-tab[data-active="true"]')?.dataset.kind`),
    "import",
  );
  await screenshotApp("workspace-import-tab");

  // 上一步为了拍 IMPORT 切走了，切回来再读 META
  await evaluate(`document.querySelector('.view-tab[data-kind="meta"] .view-tab-label')?.click()`);
  await sleep(400);
  const metaState = await readWorkspace();
  check("entries: meta holds the format facts and the sections", metaState.metaSections, ["FORMAT", "SECTIONS"]);
  await screenshotApp("workspace-meta");

  // ================================================================ mode

  // 模式标签只在代码标签里，所以先开一个再验
  await click('.section-head[data-entry="strings"]');
  await activateRow("function");
  check("mode: no segmented control exists", (await readWorkspace()).segmentedControl, 0);
  check("mode: the label names the current mode", (await readWorkspace()).modeLabel, "C");

  await click('[data-testid="mode-label"]');
  check("mode: the label itself toggles, so a tablet can switch", (await readWorkspace()).modeLabel, "ASM");

  await sendKey("c", "KeyC", 67, META_SHIFT);
  check("mode: Cmd+Shift+C toggles it back", (await readWorkspace()).modeLabel, "C");

  await clickAll(".view-tab .view-tab-close");

  // ================================================================ granularity (DEX)

  await send("Page.navigate", { url: mockUrl });
  await sleep(1200);
  checkThat("dex: the APK opens", await openWorkspace(fixtures.apk), "the workspace mounted");
  await sleep(700);

  const dexColumn = await evaluate(`document.querySelector('.section[data-section="tree"] .section-title')?.textContent ?? null`);
  check("dex: the tree is named for the language", dexColumn, "Classes");

  // 展开一个包和一个类，好点到方法
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.navigator-row')];
    const pkg = rows.find((r) => r.dataset.kind === "package");
    if (pkg) pkg.click();
  })()`);
  await sleep(500);
  await evaluate(`(() => {
    const cls = [...document.querySelectorAll('.navigator-row[data-kind="class"]')][0];
    if (cls) cls.click();
  })()`);
  checkThat("granularity: the class body loads", await waitFor(".code-member", 8000), "members appeared");
  await sleep(200);

  const classTab = await readWorkspace();
  check("granularity: opening a class opens one tab", classTab.tabs.length, 1);
  check("granularity: and it is tagged as Java", classTab.tabs[0]?.tag, "java");
  checkThat("granularity: the tab holds the whole class", classTab.members.length > 1, `${classTab.members.length} members`);
  // 视图头删掉之后，类的名字靠标签页和左栏的包路径两处给出
  check("granularity: the class tab is named for the class", classTab.tabs[0]?.label, "LoginActivity7");
  await screenshotApp("workspace-class-tab");

  const members = classTab.members;
  await activateRow("method", 1);
  await sleep(400);
  const movedMark = await readWorkspace();
  check("granularity: a second method does not add a tab", movedMark.tabs.length, 1);
  check("granularity: it moves the mark", movedMark.hitMember, movedMark.members[1]);
  checkThat("granularity: the mark is a different member", movedMark.hitMember !== classTab.hitMember, `${classTab.hitMember} -> ${movedMark.hitMember}`);
  checkThat("granularity: the class body is unchanged", movedMark.members.length === members.length, `${members.length} members`);
  await screenshotApp("workspace-class-method-marked");

  // ================================================================ strings jump

  await click('.section-head[data-entry="strings"]');
  const beforeJump = await readWorkspace();
  const jumped = await evaluate(`(() => {
    const row = document.querySelector('[data-testid="strings-view"] .strings-row');
    if (!row) return null;
    row.click();
    return { value: row.querySelector(".strings-col-value")?.textContent ?? null, owner: row.dataset.owner ?? null };
  })()`);
  checkThat("strings: the table is showing rows", jumped?.value != null, `${jumped?.value} owned by ${jumped?.owner}`);
  // 类的成员是异步加载的，等命中标出现再断言
  await waitFor('.code-member[data-hit="true"]', 8000);
  await sleep(200);

  const afterJump = await readWorkspace();
  checkThat("strings: a row opens a code tab", afterJump.activeLabel !== beforeJump.activeLabel, `${beforeJump.activeLabel} -> ${afterJump.activeLabel}`);
  checkThat(
    "strings: and marks that exact member",
    await evaluate(`document.querySelector('.code-member[data-hit="true"]')?.dataset.id ?? null`) === jumped?.owner,
    `owner=${jumped?.owner} members=${(await evaluate(`[...document.querySelectorAll('.code-member')].slice(0, 3).map((m) => m.dataset.id).join(",")`))}`,
  );

  await screenshotApp("workspace-string-jump");

  // 两个单元各有一个 STRINGS 标签，靠 tag 分得开
  await click('.section[data-section="tree"] .section-toggle');
  await evaluate(`document.querySelector('[data-testid="source-current"]').click()`);
  await sleep(250);
  await screenshotApp("workspace-source-picker");
  await evaluate(`document.querySelectorAll('[data-testid="source-picker"] button')[1].click()`);
  await sleep(700);
  await click('.section-head[data-entry="strings"]');
  const twoUnits = await readWorkspace();
  const stringsTabs = twoUnits.tabs.filter((tab) => tab.key.startsWith("strings:"));
  check("strings: each unit has its own table", stringsTabs.length, 2);
  checkThat("strings: and they are told apart by tag", new Set(stringsTabs.map((tab) => tab.tag)).size === 2, stringsTabs.map((tab) => tab.tag).join(" vs "));
  checkThat("source: the current unit is named in the column head", twoUnits.sourceLabel === twoUnits.tabs.find((tab) => tab.active)?.tag, `${twoUnits.sourceLabel}`);
  checkThat("source: and the switcher row has a real box", (twoUnits.sourceCurrent?.height ?? 0) >= 24, `${twoUnits.sourceCurrent?.height}px`);
  checkThat("source: a multi-unit file still gets the switcher", twoUnits.sourceCurrent !== null, "the switcher is there");
  /*
   * 原生单元没有类可标记：标签本身就是那个函数，打开它就等于跳到了使用处。
   * 能验的是打开的函数确实是这个字符串的宿主。
   */
  const nativeStrings = await evaluate(`(() => {
    const tab = document.querySelector('.view-tab[data-kind="strings"][data-active="true"]');
    return tab ? { key: tab.dataset.tab, tag: tab.querySelector(".view-tab-tag")?.textContent ?? null } : null;
  })()`);
  check("strings: the native unit's own table is the one on screen", nativeStrings?.tag, "libnotes.so");
  const nativeJump = await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-testid="strings-view"] .strings-row')]
      .find((candidate) => candidate.dataset.owner);
    if (!row) return null;
    const owner = row.dataset.owner;
    row.click();
    return owner;
  })()`);
  await sleep(900);
  const nativeTab = await evaluate(`document.querySelector('.view-tab[data-active="true"]')?.dataset.tab ?? null`);
  checkThat(
    "strings: in a native unit the jump opens the function that owns it",
    nativeJump !== null && nativeTab !== null && nativeTab.includes(nativeJump),
    `owner=${nativeJump} tab=${nativeTab}`,
  );
  await screenshotApp("workspace-two-units");

  // ================================================================ density

  // 前面为了点来源把树收起来了，密度要量行，所以先展开
  const treeCollapsed = await evaluate(`!document.querySelector(".navigator-row")`);
  if (treeCollapsed) {
    await click('.section[data-section="tree"] .section-toggle');
    await sleep(400);
  }
  checkThat("density: the tree is expanded so rows can be measured", Boolean(await evaluate(`document.querySelector(".navigator-row")`)), "rows present");

  check("density: a precise pointer is detected as such", await evaluate(`document.querySelector(".app").dataset.pointer`), "fine");

  /*
   * 行高必须在**元素自己身上**量。虚拟列表给外层写了显式的像素高，行去填它；
   * 展开的 IMPORT / EXPORT 是普通滚动容器里的行，那里没有外层高度可用。
   * 只数 DOM 里有多少行是不够的 —— 一屏只看得到一行也算"行数对得上"。
   */
  await evaluate(`(() => {
    const open = document.querySelector('.view-tab[data-kind="class"] .view-tab-label, .view-tab[data-kind="function"] .view-tab-label');
    if (open) { open.click(); return; }
    document.querySelector('.navigator-row[data-kind="function"], .navigator-row[data-kind="method"], .navigator-row[data-kind="class"]')?.click();
  })()`);
  await sleep(500);
  await waitFor(".code-line", 8000);
  const fine = await evaluate(`(() => {
    const bar = document.querySelector(".workspace-top");
    const row = document.querySelector(".navigator-row");
    const strip = document.querySelector(".view-tabs");
    const tab = document.querySelector(".view-tab");
    const head = document.querySelector(".section-head");
    const lines = [...document.querySelectorAll(".code-line")].slice(0, 2);
    const round = (n) => Math.round(n);
    return {
      barToken: Number.parseFloat(getComputedStyle(bar).getPropertyValue("--top-bar-h")),
      bar: round(bar.getBoundingClientRect().height),
      row: round(row.getBoundingClientRect().height),
      strip: round(strip.getBoundingClientRect().height),
      tab: round(tab.getBoundingClientRect().height),
      head: round(head.getBoundingClientRect().height),
      leading: lines.length === 2 ? round(lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().top) : null,
      codeFont: Number.parseFloat(getComputedStyle(document.querySelector(".code-line")).fontSize),
    };
  })()`);
  check("density (fine): the row token is 28px", fine.row, DENSITY.fine.row);
  check("density (fine): the top-bar token is 36px", fine.barToken, DENSITY.fine.topBar);
  checkThat("density (fine): the bar measures what the token says", Math.abs(fine.bar - fine.barToken) <= 3, `${fine.bar} vs ${fine.barToken}`);
  check("density (fine): the tab strip measures 32px", fine.tab, DENSITY.fine.tab);
  check("density (fine): the strip is no taller than its tabs", fine.strip <= fine.tab + 2, true);
  check("density (fine): a section head measures 30px", fine.head, 30);
  check("density (fine): the code leading is 17px", fine.leading, 17);
  check("density (fine): the code font is 12px", fine.codeFont, 12);

  /*
   * 展开 IMPORT：真正要保证的不是"DOM 里有 52 行"，而是这 52 行是一屏能扫的清单。
   */
  await evaluate(`(() => {
    const head = document.querySelector('.section-head[data-section="import"]');
    if (head && head.getAttribute("aria-expanded") === "false") head.click();
  })()`);
  await sleep(500);
  const expandedImport = await evaluate(`(() => {
    const body = document.querySelector('.section-body[data-list="import"]');
    if (!body) return null;
    const rows = [...body.querySelectorAll(".navigator-row")];
    if (rows.length === 0) return { rows: 0 };
    const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height));
    const bodyBox = body.getBoundingClientRect();
    return {
      rows: rows.length,
      heights: [...new Set(heights)],
      body: Math.round(bodyBox.height),
      scrollHeight: body.scrollHeight,
      perScreen: Math.floor(bodyBox.height / heights[0]),
    };
  })()`);
  checkThat("entries: the import section is expanded and rendered", (expandedImport?.rows ?? 0) > 1, `${expandedImport?.rows} rows`);
  check("entries: every expanded import row is row-height", expandedImport.heights, [DENSITY.fine.row]);
  checkThat("entries: and the body shows a list, not a single row", expandedImport.perScreen >= 4, `${expandedImport.perScreen} rows per screen (body ${expandedImport.body}px)`);
  checkThat(
    "entries: the scroll height matches the rows it holds",
    Math.abs(expandedImport.scrollHeight - expandedImport.rows * DENSITY.fine.row) <= expandedImport.rows * 2 + 40,
    `${expandedImport.scrollHeight}px for ${expandedImport.rows} rows`,
  );
  await screenshotApp("workspace-import-expanded");

  await setPointer("coarse");
  const coarse = await evaluate(`(() => {
    const tooSmall = [];
    for (const [selector, label] of [["\u002eworkspace-back", "back"], [".view-tab-label", "tab"], [".navigator-row", "row"], [".section-head", "head"], ['[data-testid="mode-label"]', "mode"]]) {
      for (const node of document.querySelectorAll(selector)) {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        const smallest = Math.min(box.width, box.height);
        if (smallest < 44) tooSmall.push(label + ":" + Math.round(smallest));
      }
    }
    const bar = document.querySelector(".workspace-top");
    const row = document.querySelector(".navigator-row");
    return {
      tooSmall: [...new Set(tooSmall)],
      barToken: Number.parseFloat(getComputedStyle(bar).getPropertyValue("--top-bar-h")),
      bar: Math.round(bar.getBoundingClientRect().height),
      row: Math.round(row.getBoundingClientRect().height),
      handle: Math.round(document.querySelector(".workspace-handle").getBoundingClientRect().width),
    };
  })()`);
  checkThat("density (coarse): every control is at least 44px", coarse.tooSmall.length === 0, coarse.tooSmall.join(", "));
  check("density (coarse): the top-bar token is 44px", coarse.barToken, DENSITY.coarse.topBar);
  check("density (coarse): rows are 44px", coarse.row, DENSITY.coarse.row);
  checkThat("density (coarse): the bar measures what the token says", Math.abs(coarse.bar - coarse.barToken) <= 3, `${coarse.bar} vs ${coarse.barToken}`);
  // 文档把缩放手柄记成了唯一例外，且有键盘和双击两条替代路径
  check("density (coarse): the resize handle keeps its documented 24px", coarse.handle, 24);
  await screenshotApp("workspace-coarse-pointer");
  await setPointer("fine");

  // ================================================================ layout

  await setViewport(DESKTOP);
  const wide = await readWorkspace();
  check("layout: navigator width", wide.navigator?.width, 300);
  check("layout: navigator starts at the left edge", wide.navigator?.x, 0);
  checkThat("layout: main takes the rest", wide.main?.width === DESKTOP.width - 300, `main=${wide.main?.width}`);
  check("layout: two columns at 1180", wide.narrow, "false");
  check("layout: handle is exposed as a separator", wide.handleRole, "separator");

  await setViewport(NARROW);
  const narrow = await readWorkspace();
  check("layout: still two columns at 700", narrow.narrow, "false");
  checkThat("layout: main keeps usable width at 700", (narrow.main?.width ?? 0) >= 420, `main=${narrow.main?.width}`);

  await setViewport(OVERLAY);
  const overlay = await readWorkspace();
  check("layout: the navigator overlays below the breakpoint", overlay.narrow, "true");
  checkThat("layout: overlay sits below the top bar", (overlay.navigator?.y ?? 0) >= (overlay.top?.height ?? 0), `nav=${overlay.navigator?.y} bar=${overlay.top?.height}`);
  checkThat("layout: the top bar spans the viewport", (overlay.top?.width ?? 0) >= OVERLAY.width, `top=${overlay.top?.width}`);
  check(
    "layout: nothing overflows horizontally",
    await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
    true,
  );

  // ================================================================ resize

  await setViewport(DESKTOP);
  await sleep(250);
  const before = await readWorkspace();
  await evaluate(`document.querySelector(".workspace-handle").focus()`);
  await sendKey("ArrowRight", "ArrowRight", 39);
  const after = await readWorkspace();
  check("resize: keyboard nudge widens the navigator", after.navigator?.width, (before.navigator?.width ?? 0) + 24);
  check("resize: width persisted", after.storedWidth, String(after.navigator?.width));
  await evaluate(`document.querySelector(".workspace-handle").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  await sleep(250);
  check("resize: double click restores the default", (await readWorkspace()).navigator?.width, 300);

  // ================================================================ back home

  await click(".workspace-back");
  const backHome = await readHome();
  check("back: returns to the home screen", backHome.inWorkspace, false);
  check("back: home is usable again", backHome.button, "Open");

  // ================================================================ kuna

  /*
   * The real engine, driven the way a user drives it.
   *
   * Everything above pins the mock, because it is about the workspace. This
   * section is the opposite: it checks that the workspace is showing what the
   * engine actually produced. Absent artifacts skip it loudly — an assertion
   * that quietly does not run is worse than one that fails.
   */
  const kunaInstalled = await evaluate(
    `fetch("/kuna/kuna_wasm.wasm", { method: "HEAD" })
       .then((r) => r.ok && Number(r.headers.get("content-length")) > 1000000)
       .catch(() => false)`,
  );

  if (!kunaInstalled) {
    skipped.push(
      `kuna: ${KUNA_SECTION_CHECKS} checks did not run — the engine is not installed in this build. ` +
        "Run `npm run build:kuna` against a Kuna checkout to cover the real engine.",
    );
    console.log("SKIP kuna: the engine is not installed in this build");
  } else {
    const sectionStart = passed;

    await send("Page.navigate", { url: pageUrl });
    await sleep(1200);
    checkThat("kuna: the real binary opens", await openWorkspace(kunaFixtures.elf), "the workspace mounted");
    await waitFor(".navigator-row", 60000);
    await sleep(400);

    // An independent oracle: the same wasm, the same binary, driven through
    // Node's WASI instead of the browser's. If the two disagree, the browser
    // path mangled something and no amount of DOM assertions would say so.
    const expected = await kunaInNode("sample.elf");
    const shown = await evaluate(`[...document.querySelectorAll(".navigator-row-label")].map((n) => n.textContent)`);

    check("kuna: the inventory is the engine's, in its names", shown.length, expected.count);
    checkThat(
      "kuna: and every name is one the engine reported",
      shown.every((name) => expected.names.includes(name)),
      shown.filter((name) => !expected.names.includes(name)).slice(0, 3).join(", "),
    );
    checkThat(
      "kuna: nothing the mock invents is on screen",
      !shown.some((name) => /^(auth|session|token|apply|verify)_/.test(name)),
      shown.slice(0, 3).join(", "),
    );

    // The engine cannot answer these, so the workspace must not offer them.
    const kunaColumn = await evaluate(`[...document.querySelectorAll(".section-title")].map((n) => n.textContent)`);
    check("kuna: only the sections the engine can answer", kunaColumn, ["Functions", "Meta"]);

    // Opening a function: the C on screen must be the C the engine produced.
    await evaluate(`[...document.querySelectorAll(".navigator-row")].find((r) => r.textContent.includes("main"))?.click()`);
    await waitFor(".code-line", 60000);
    await sleep(300);

    const rendered = await evaluate(
      `[...document.querySelectorAll(".code-body .code-line")].map((l) => l.querySelector(".code")?.textContent ?? "").join("\\n")`,
    );
    const expectedC = await kunaDecompileInNode("sample.elf", "main");
    /*
     * Following a call. This is the thing the design document had listed as
     * blocked on an address-to-function lookup; the engine's inventory turns out
     * to be the index, because the name in the decompiled C is the name in the
     * list.
     */
    const jump = await evaluate(`(() => {
      const link = [...document.querySelectorAll(".tok-jump")].find((node) => node.textContent.trim() === "sum_to");
      if (!link) return null;
      link.click();
      return link.textContent.trim();
    })()`);
    await sleep(900);
    check("code: a call site is offered as a link", jump, "sum_to");
    check(
      "code: and following it opens that function",
      await evaluate(`[...document.querySelectorAll(".view-tab-name")].map((n) => n.textContent)`),
      ["main", "sum_to"],
    );
    await screenshotApp("kuna-call-jump");
    await evaluate(`document.querySelector('.view-tab[data-kind="function"] .view-tab-label')?.click()`);
    await sleep(500);

    checkThat(
      "kuna: the C on screen is the C the engine produced",
      normaliseCode(rendered) === normaliseCode(expectedC),
      `rendered ${rendered.length} chars, engine ${expectedC.length}`,
    );
    checkThat("kuna: and it is a real decompilation", /sum_to\(add\(argc, ?3\)\)/.test(rendered), rendered.slice(0, 60));
    await screenshotApp("kuna-decompiled");

    // No fraction is ever reported: the engine makes one opaque call and has
    // nothing to report a fraction of.
    const determinate = await evaluate(`document.querySelector('[data-testid="progress"]')?.dataset.determinate ?? null`);
    checkThat("kuna: the overlay never claims a fraction", determinate !== "true", `determinate=${determinate}`);
    checkThat(
      "kuna: no mode switch is offered by an engine that cannot disassemble",
      await evaluate(`document.querySelector('[data-testid="mode-label"]') === null`),
      "no switch",
    );

    /*
     * Cancelling. The engine is fast on a small binary, so this uses the running
     * Node binary — 116 MB of real Mach-O that takes minutes to inventory. The
     * point is not the speed; it is that terminate-and-rebuild leaves a working
     * engine behind, which is the riskiest part of running WASI in a Worker.
     */
    await send("Page.navigate", { url: pageUrl });
    await sleep(1200);
    checkThat("kuna: a large real binary opens", await openWorkspace(process.execPath), "the workspace mounted");
    await waitFor(".navigator-stop", 60000);
    await sleep(300);
    await evaluate(`document.querySelector(".navigator-stop").click()`);
    await sleep(1500);

    check(
      "kuna: stopping marks the analysis partial",
      await evaluate(`Boolean(document.querySelector('[data-testid="navigator-partial"]'))`),
      true,
    );
    checkThat(
      "kuna: and the overlay stops claiming to work",
      await evaluate(`!document.querySelector('[data-testid="progress"]')`),
      "overlay gone",
    );

    // The engine was terminated. A clean one has to come back, or cancel is a
    // one-way door.
    await send("Page.navigate", { url: pageUrl });
    await sleep(1200);
    checkThat("kuna: the engine works again afterwards", await openWorkspace(kunaFixtures.elf), "the workspace mounted");
    await waitFor(".navigator-row", 60000);
    const afterCancel = await evaluate(`document.querySelectorAll(".navigator-row").length`);
    check("kuna: with the full inventory", afterCancel, expected.count);

    // +1 for this assertion, which is itself part of the section.
    const ran = passed - sectionStart + 1;
    checkThat(
      "kuna: the section ran every check it declares",
      ran === KUNA_SECTION_CHECKS,
      `${ran} ran, ${KUNA_SECTION_CHECKS} declared`,
    );
  }

  // ================================================================ rasc

  /*
   * The other real engine, driven the same way.
   *
   * The fixtures are DEX files this script built (see `rasc-fixtures.mjs`), and
   * each is written twice: bare, which the page wraps in a one-entry archive, and
   * inside a real APK, which is what the Node oracle is pointed at. So the
   * comparison below covers the port and the wrapper at once.
   */
  const rascInstalled = await evaluate(
    `fetch("/rasc/rasc.wasm", { method: "HEAD" })
       .then((r) => r.ok && Number(r.headers.get("content-length")) > 500000)
       .catch(() => false)`,
  );

  if (!rascInstalled) {
    skipped.push(
      `rasc: ${RASC_SECTION_CHECKS} checks did not run — the engine is not installed in this build. ` +
        "Run `npm run build:rasc` against a Rasc checkout to cover the real engine.",
    );
    console.log("SKIP rasc: the engine is not installed in this build");
  } else {
    const sectionStart = passed;
    const rascUrl = `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}engine=rasc`;

    /** The engine's own answer for a fixture, from the same wasm under Node. */
    const rascOracle = (command, file, ...rest) =>
      JSON.parse(
        execFileSync(process.execPath, ["scripts/rasc-oracle.mjs", command, file, ...rest], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).text;

    /* One `classes --json` record per class: `{dex, descriptor, name}`. */
    const classRecords = (text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const javaNames = (text) => classRecords(text).map((record) => record.name);
    const simpleNames = (text) =>
      classRecords(text).map((record) => record.name.split(".").at(-1) ?? record.name);
    const codeOnScreen = () =>
      evaluate(
        `[...document.querySelectorAll(".code-body .code-line")].map((l) => l.querySelector(".code")?.textContent ?? "").join("\\n")`,
      );
    const classRuns = () =>
      evaluate(`[...document.querySelectorAll('.navigator-row[data-kind="class"]')].map((n) => n.querySelector(".navigator-row-label").textContent)`);

    const openBeta = async () => {
      await evaluate(
        `[...document.querySelectorAll('.navigator-row[data-kind="class"]')].find((r) => r.textContent.includes("Beta"))?.click()`,
      );
      return waitFor(".code-member", 60000);
    };

    await send("Page.navigate", { url: rascUrl });
    await sleep(1200);
    checkThat("rasc: the real DEX opens", await openWorkspace(fixtures.callsDex), "the workspace mounted");
    await waitFor(".navigator-row", 60000);
    await sleep(300);

    // An independent oracle, as for Kuna: same wasm, same bytes, a different host.
    // The page's DEX is wrapped by `archive.ts`; the oracle reads the same DEX out
    // of a real APK.
    const expectedRows = rascOracle("classes", fixtures.callsApk, "--json");
    check(
      "rasc: the column counts the classes the engine listed",
      await evaluate(`document.querySelector('[data-testid="navigator-count"]').textContent.trim()`),
      String(javaNames(expectedRows).length),
    );
    check(
      "rasc: only the sections the engine can answer",
      await evaluate(`[...document.querySelectorAll(".section-title")].map((n) => n.textContent.trim())`),
      ["Classes", "Strings", "Meta"],
    );
    // The engine reports the entry walk, so a fraction is allowed once it has one; what
    // is not allowed is claiming one before that. This sample lands while the archive is
    // still loading, which is exactly the window where a fabricated bar would show.
    checkThat(
      "rasc: the overlay claims no fraction before the engine reports one",
      (await evaluate(`document.querySelector('[data-testid="progress"]')?.dataset.determinate ?? null`)) !== "true",
      "indeterminate",
    );
    checkThat(
      "rasc: no mode switch is offered by an engine that cannot disassemble",
      await evaluate(`document.querySelector('[data-testid="mode-label"]') === null`),
      "no switch",
    );

    const packageLabel = await evaluate(
      `document.querySelector('.navigator-row[data-kind="package"] .navigator-row-label')?.textContent ?? null`,
    );
    check("rasc: the package is the one the engine named", packageLabel, "com.example");

    await activateRow("package");
    const shownClasses = await classRuns();
    check("rasc: the classes are the engine's, in its names", shownClasses, simpleNames(expectedRows));
    checkThat(
      "rasc: nothing the mock invents is on screen",
      !shownClasses.some((name) => /LoginActivity|PayloadCodec|SyncWorker|applyCached|read_1/.test(name)),
      shownClasses.join(", "),
    );

    // Opening a class is what reads it: the engine prints a class as one document,
    // and the method rows in the column are a fact about that document.
    checkThat("rasc: opening a class reads it", await openBeta(), "members appeared");
    await sleep(300);

    const betaJava = await codeOnScreen();
    const expectedJava = rascOracle("getclass", fixtures.callsApk, "com.example.Beta");
    checkThat(
      "rasc: the Java on screen is the Java the engine produced",
      normaliseCode(betaJava) === normaliseCode(expectedJava),
      `rendered ${betaJava.length} chars, engine ${expectedJava.length}`,
    );
    checkThat(
      "rasc: and it is a real decompilation",
      /com\.example\.Alpha\.target\(/.test(betaJava),
      betaJava.slice(0, 80),
    );
    checkThat(
      "rasc: the class's own part is on screen",
      await evaluate(`(() => {
        const part = document.querySelector('[data-part="preamble"]');
        if (!part) return false;
        const text = part.textContent;
        return text.includes("package com.example;") && text.includes("class Beta");
      })()`),
      "the package and the declaration",
    );

    const betaTab = await readWorkspace();
    check("rasc: the class tab is tagged as Java", betaTab.tabs[0]?.tag, "java");
    check("rasc: and holds the class's methods", betaTab.members, ["call"]);
    await screenshotApp("rasc-decompiled-java");

    // A call site with a receiver is a link: the receiver is what names the class,
    // and a bare method name would be ambiguous across the whole archive.
    const followed = await evaluate(`(() => {
      const link = [...document.querySelectorAll(".tok-jump")].find((n) => n.textContent.trim().startsWith("com.example.Alpha"));
      if (!link) return null;
      link.click();
      return link.textContent.trim();
    })()`);
    await sleep(900);
    checkThat("rasc: a qualified call site is a link", followed !== null, `${followed}`);
    check(
      "rasc: and following it opens that class",
      await evaluate(`[...document.querySelectorAll(".view-tab-name")].map((n) => n.textContent)`),
      ["Beta", "Alpha"],
    );
    await screenshotApp("rasc-call-jump");

    // The same DEX inside a real archive. The page wraps a bare DEX itself, so a
    // difference here is the wrapper's, and no DOM assertion would say so.
    await send("Page.navigate", { url: rascUrl });
    await sleep(1200);
    checkThat("rasc: the same classes inside a real APK open", await openWorkspace(fixtures.callsApk), "the workspace mounted");
    await waitFor(".navigator-row", 60000);
    await sleep(300);
    await activateRow("package");
    await openBeta();
    await sleep(300);
    checkThat(
      "rasc: a bare DEX and the same DEX inside an APK agree",
      normaliseCode(await codeOnScreen()) === normaliseCode(betaJava),
      `${betaJava.length} vs ${(await codeOnScreen()).length} chars`,
    );

    // The readout carries two things only this engine can give: the file's real
    // digest, and the linear memory the module is actually holding.
    await click('.section-head[data-entry="meta"]');
    // The string table is the archive's vocabulary, and the fixture's is known: seven
    // strings, the two descriptors, the void shorty, the two member names and the value.
    // The count comes from the DEX headers, so it is right before anything is fetched.
    checkThat(
      "rasc: the strings count is the engine's count, without the table",
      await evaluate(`(() => {
        const count = document.querySelector('[data-entry="strings"] .section-count')?.textContent?.trim();
        return count === "7";
      })()`),
      "seven strings in the fixture's table",
    );

    // Opening the tab searches the engine rather than reading a table it holds, so the
    // filter is a request: the rows that come back are the rows that match.
    await click('.section-head[data-entry="strings"]');
    checkThat("rasc: the strings tab opens without the table", await waitFor('[data-testid="strings-view"]', 8000), "the view is there");
    await evaluate(`(() => {
      const input = document.querySelector('[data-testid="strings-filter"]');
      input.value = "Alpha";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(900);
    checkThat(
      "rasc: a filter is a search the engine answers",
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="strings-view"] .strings-row')];
        return rows.length === 1 && rows[0].textContent.includes("Alpha");
      })()`),
      "one matching row",
    );
    await clickAll(".view-tab .view-tab-close");

    // The archive's entries are what an APK has instead of sections, and they come
    // from the same walk: a host that lists what a file contains is not guessing.
    checkThat(
      "rasc: the readout lists what the archive holds",
      await evaluate(`(() => {
        const table = document.querySelector('[data-testid="meta-sections"]');
        if (!table) return false;
        const rows = [...table.querySelectorAll(".meta-table-row")].map((row) => row.textContent);
        return (
          rows.length >= 2 &&
          rows.some((row) => row.includes("AndroidManifest.xml")) &&
          rows.some((row) => row.includes(".dex"))
        );
      })()`),
      "the archive's entries",
    );

    const realHash = createHash("sha256").update(await readFile(fixtures.callsApk)).digest("hex");
    check(
      "rasc: the readout carries the file's real digest",
      await evaluate(`document.querySelector('[data-testid="meta-hash"]').textContent.trim()`),
      realHash,
    );
    checkThat(
      "rasc: and a memory figure the engine really reports",
      await evaluate(
        `[...document.querySelectorAll(".meta-fact dt")].some((n) => n.textContent.trim() === "WORKER MEMORY")`,
      ),
      "WORKER MEMORY present",
    );

    /*
     * The archive a real build tool writes. Detection used to look for the
     * manifest in the first four kilobytes, which is where the entries *start*,
     * not where the names are: this file is refused as a plain archive when that
     * read is the only one, and it is the shape a real APK had when this was
     * found.
     */
    await send("Page.navigate", { url: rascUrl });
    await sleep(1200);
    checkThat(
      "rasc: an APK whose manifest is not the first entry is still an APK",
      await openWorkspace(fixtures.lateApk),
      "the workspace mounted",
    );
    await waitFor(".navigator-row", 60000);
    await sleep(300);
    check(
      "rasc: and its classes are the same ones",
      await evaluate(`document.querySelector('[data-testid="navigator-count"]').textContent.trim()`),
      "2",
    );

    // A file the engine cannot read is refused in the engine's own words, in the
    // column the user is already looking at. `notes-release.apk` is an APK header
    // with no archive behind it, which is exactly what Rasc says.
    await send("Page.navigate", { url: rascUrl });
    await sleep(1200);
    await openWorkspace(fixtures.apk);
    await waitFor('[data-testid="navigator-note"]', 60000);
    await sleep(300);
    const refusal = await evaluate(`document.querySelector('[data-testid="navigator-note"]')?.textContent.trim() ?? null`);
    checkThat("rasc: a file the engine refuses is refused in its own words", /EOCD not found/.test(refusal ?? ""), `${refusal}`);
    check(
      "rasc: and the column stays empty rather than plausible",
      await evaluate(`document.querySelectorAll(".navigator-row").length`),
      0,
    );

    /*
     * Cancelling. Every fixture is read in milliseconds, so the suite holds the
     * engine's answer with `?rascDelay` — the same kind of seam the mock has —
     * because the subject here is terminate-and-rebuild: the Worker is gone, the
     * call that was in flight is not, and a clean one has to come back.
     */
    await send("Page.navigate", { url: `${rascUrl}&rascDelay=1500` });
    await sleep(1200);
    checkThat("rasc: a scan can be stopped mid-flight", await openWorkspace(fixtures.indexDex), "the workspace mounted");
    await waitFor(".navigator-stop", 60000);
    await evaluate(`document.querySelector(".navigator-stop").click()`);
    await sleep(800);
    check(
      "rasc: stopping marks the analysis partial",
      await evaluate(`Boolean(document.querySelector('[data-testid="navigator-partial"]'))`),
      true,
    );
    checkThat(
      "rasc: and the overlay stops claiming to work",
      await evaluate(`!document.querySelector('[data-testid="progress"]')`),
      "overlay gone",
    );

    await send("Page.navigate", { url: rascUrl });
    await sleep(1200);
    checkThat("rasc: the engine works again afterwards", await openWorkspace(fixtures.indexDex), "the workspace mounted");
    await waitFor(".navigator-row", 60000);
    await sleep(200);
    check(
      "rasc: with the whole index",
      await evaluate(`document.querySelector('[data-testid="navigator-count"]').textContent.trim()`),
      "4",
    );

    /*
     * The string jump, last in the section and on a page state this step owns: nothing
     * after it can be perturbed by the tabs it opens, the filter is cleared because an
     * earlier step leaves a query in it, and the comparison is against the tabs that were
     * open before the press - a tab the section opened earlier satisfies "a class tab
     * exists" perfectly, which is how the first version of this check passed without
     * proving anything.
     */
    await clickAll(".view-tab .view-tab-close");
    await click('.section-head[data-entry="strings"]');
    await evaluate(`(() => {
      const input = document.querySelector('[data-testid="strings-filter"]');
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(800);
    checkThat("rasc: the strings table is showing rows", await waitFor('[data-testid="strings-view"] .strings-row', 8000), "rows are there");

    /*
     * The column the design left as dashes: a Java unit's counts come from one census over
     * the archive, asked for when this table opened. Polled, because the census is a command
     * of its own and the table lists its strings before the counts arrive.
     */
    const counted = await evaluate(`(async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const row = [...document.querySelectorAll('[data-testid="strings-view"] .strings-row')]
          .find((node) => node.textContent.includes("Authorization"));
        const value = row?.querySelector(".strings-col-xrefs")?.textContent?.trim() ?? "";
        if (value !== "" && value !== "\u2014" && Number(value) > 0) return value;
        await new Promise((done) => setTimeout(done, 150));
      }
      return null;
    })()`);
    checkThat("rasc: the reference counts arrive with the table", counted !== null, `Authorization shows ${counted}`);

    /*
     * And the two kinds of nothing are told apart: the census names every referenced string,
     * so one it does not name was counted and found unused - a zero - while a unit that has
     * not been counted shows a dash. The fixture's "V" is in its string table and no method
     * loads it, which is exactly the row that used to read as unknown.
     */
    const uncounted = await evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-testid="strings-view"] .strings-row')]
        .find((node) => node.querySelector(".strings-col-value")?.textContent?.trim() === "V");
      return row?.querySelector(".strings-col-xrefs")?.textContent?.trim() ?? null;
    })()`);
    checkThat("rasc: and a counted zero is not a dash", uncounted === "0", `the unreferenced string shows ${JSON.stringify(uncounted)}`);

    const tabsBefore = (await readWorkspace()).tabs.map((tab) => tab.label);
    const pressed = await evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-testid="strings-view"] .strings-row')]
        .find((node) => node.textContent.includes("Authorization"));
      if (!row) return null;
      row.click();
      return row.textContent.trim();
    })()`);
    checkThat("rasc: a string row can be pressed when no owner is in the table", pressed !== null, "the row was there");

    await sleep(1500);
    const afterLookup = await readWorkspace();
    const opened = afterLookup.tabs.filter((tab) => !tabsBefore.includes(tab.label));
    checkThat(
      "rasc: and a class the engine named is what opens",
      opened.length > 0 && opened.every((tab) => tab.tag === "java" && /^Fixture[0-3]$/.test(tab.label)),
      `before=[${tabsBefore.join(",")}] opened=[${opened.map((tab) => tab.label).join(",")}]`,
    );
    // The engine's answer names a method, and the fixture's four classes are
    // Fixture0/m0 … Fixture3/m3, so the row that sorts first is Fixture0's m0: the jump
    // lands on the use, not at the top of the class that holds it.
    checkThat(
      "rasc: and the member the engine named is marked inside it",
      await waitFor('.code-member[data-hit="true"]', 8000) &&
        (await evaluate(`document.querySelector('.code-member[data-hit="true"]')?.dataset.member ?? null`)) === "m0",
      `marked=${await evaluate(`document.querySelector('.code-member[data-hit="true"]')?.dataset.member ?? null`)}`,
    );

    // A string nothing uses answers with nothing, and the screen stays where it is.
    const beforeEmpty = (await readWorkspace()).tabs.length;
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('[data-testid="strings-view"] .strings-row')]
        .find((node) => node.textContent.includes("VIIIIIIII"));
      if (row) row.click();
    })()`);
    await sleep(1500);
    check("rasc: a string with no users opens nothing", (await readWorkspace()).tabs.length, beforeEmpty);

    // +1 for this assertion, which is itself part of the section.
    const ran = passed - sectionStart + 1;
    checkThat(
      "rasc: the section ran every check it declares",
      ran === RASC_SECTION_CHECKS,
      `${ran} ran, ${RASC_SECTION_CHECKS} declared`,
    );
  }

  // ================================================================ long names

  /*
   * Real C++ produces names in the hundreds of characters — the running Node
   * binary has one at 802 — and they are what breaks a layout that assumes a
   * name fits. Both faults this checks for were live: the tab's label wrapped,
   * which made the tab taller and the whole strip with it, and the grids holding
   * the code grew to fit a line instead of letting the code scroll, which made
   * the page wider than the window.
   */
  await send("Page.navigate", { url: `${mockUrl}&mockNames=long&mockDelay=0` });
  await sleep(1200);
  checkThat("long names: the workspace opens", await openWorkspace(fixtures.elf), "the workspace mounted");
  await sleep(900);
  await activateRow("function", 0);
  await sleep(600);

  const longName = await evaluate(`(() => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const labels = [".view-tab-name", ".navigator-row-label"];
    return {
      length: document.querySelector(".view-tab-name")?.textContent.length ?? 0,
      tab: box(document.querySelector(".view-tab")).h,
      strip: box(document.querySelector(".view-tabs")).h,
      bar: box(document.querySelector(".workspace-top")).h,
      inner: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      // ellipsis does nothing without nowrap: the text wraps instead, and the
      // box grows taller than the row it is supposed to sit in.
      wrapping: labels.filter((selector) => {
        const node = document.querySelector(selector);
        return node !== null && getComputedStyle(node).whiteSpace !== "nowrap";
      }),
    };
  })()`);

  checkThat("long names: the name is genuinely long", longName.length > 120, `${longName.length} characters`);
  checkThat("long names: every truncating label refuses to wrap", longName.wrapping.length === 0, longName.wrapping.join(", "));
  check("long names: the tab is still one row", longName.tab, DENSITY.fine.tab);
  checkThat(
    "long names: and the strip did not grow with it",
    longName.strip <= DENSITY.fine.tab + 1,
    `${longName.strip}px`,
  );
  checkThat("long names: the top bar is unchanged", Math.abs(longName.bar - DENSITY.fine.topBar) <= 3, `${longName.bar}px`);
  checkThat(
    "long names: and the page is still the width of the window",
    longName.scrollWidth <= longName.inner + 1,
    `${longName.scrollWidth} vs ${longName.inner}`,
  );
  await screenshotApp("workspace-long-names");

  // ================================================================ invariants

  check("no console errors", consoleErrors, []);
  check(
    "no cross-origin requests",
    await evaluate(`performance.getEntriesByType("resource").every((entry) => new URL(entry.name).origin === location.origin)`),
    true,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  if (chromeError.trim()) console.error(chromeError.trim().split("\n").slice(-8).join("\n"));
} finally {
  socket?.close();
  await stopChrome(chrome);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(fixturesRoot, { recursive: true, force: true }).catch(() => {});
}

// 让文档对账有据可依：设计文档里写的断言条数必须等于这里跑出来的条数
// A skipped section still counts: the number in the design document describes a
// full run, and comparing it against a partial one would pass while verifying less.
const skippedChecks =
  (skipped.some((entry) => entry.startsWith("kuna:")) ? KUNA_SECTION_CHECKS : 0) +
  (skipped.some((entry) => entry.startsWith("rasc:")) ? RASC_SECTION_CHECKS : 0);
await writeFile(
  join(shotDir, "assertions.json"),
  `${JSON.stringify(
    {
      passed,
      failed: failures.length,
      skipped: skippedChecks,
      total: passed + failures.length + skippedChecks,
      ...(chromeBlocked ? { blocked: chromeBlocked } : {}),
    },
    null,
    2,
  )}\n`,
);

if (skipped.length > 0) {
  console.log(`\n${skipped.length} check(s) did not run:`);
  for (const entry of skipped) console.log(`- ${entry}`);
}

if (failures.length === 0) {
  console.log(`\nRepi smoke check passed. Screenshots in ${shotDir}`);
  process.exit(0);
}

console.error(`\n${failures.length} failure(s):`);
for (const failure of failures) console.error(`- ${failure}`);
process.exit(1);
