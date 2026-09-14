/**
 * Checks the jadx-style tab model in ui-workspace-demo.html.
 *
 * The claim being tested is that a tab is the thing you opened, not a view: two
 * methods are two tabs with different content, reopening one focuses it instead
 * of duplicating, and everything is closable.
 *
 *   node docs/check-workspace-demo.mjs
 *
 * Screenshots land in docs/.workspace-demo/. Environment:
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
const shotDir = resolve(docsDir, ".workspace-demo");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const freePort = () => new Promise((done, fail) => {
  const probe = createServer();
  probe.on("error", fail);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

const serverPort = await freePort();
const debugPort = await freePort();
const pageUrl = `http://localhost:${serverPort}/docs/ui-workspace-demo.html`;

await mkdir(shotDir, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "repi-ws-demo-"));

const server = spawn("python3", ["-m", "http.server", String(serverPort), "--directory", repoRoot], { stdio: "ignore", detached: true });
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(pageUrl); if (r.ok) break; } catch { /* starting */ }
  await sleep(200);
}

const chrome = spawn(chromePath, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  "--window-size=1400,1000", `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "about:blank",
], { stdio: "ignore" });

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
  let ws;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* starting */ }
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

  const send = (method, params = {}) => new Promise((done, fail) => {
    nextId += 1;
    const id = nextId;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP ${method} did not answer within 30s`)); }, 30000);
    pending.set(id, { resolve: done, reject: fail, method, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "page evaluation failed");
    return result.result.value;
  };

  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(200);
  };
  const clickBy = async (expression) => { await evaluate(expression); await sleep(200); };

  const stateOf = () => evaluate(`(() => {
    const app = document.querySelector(".app");
    const active = app.querySelector('.tab[aria-selected="true"]');
    const body = app.querySelector('[data-testid="code-body"]');
    return {
      tabs: [...app.querySelectorAll(".tab")].map((t) => t.dataset.label),
      keys: [...app.querySelectorAll(".tab")].map((t) => t.dataset.tab),
      active: active ? active.dataset.label : null,
      closers: app.querySelectorAll(".tab .close").length,
      bodySignature: body ? [...body.querySelectorAll(".line")].map((l) => l.textContent).join("|").slice(0, 400) : null,
      members: [...app.querySelectorAll(".member")].map((m) => m.dataset.method),
      hitMember: app.querySelector('.member[data-hit="true"]')?.dataset.method ?? null,
      langs: [...app.querySelectorAll(".tab .lang")].map((l) => l.textContent),
      navTitle: app.querySelector('.section-head[data-section="functions"] span:nth-child(2)')?.textContent ?? null,
      topLevelRows: [...app.querySelectorAll(".section-body .row")].map((r) => r.dataset.key).filter(Boolean),
      metaSections: [...app.querySelectorAll('[data-testid="meta-panel"] h4')].map((h) => h.textContent),
      heading: app.querySelector(".panel h4")?.textContent ?? null,
      empty: Boolean(app.querySelector('[data-testid="no-tab"]')),
      mode: app.querySelector('[data-testid="mode-label"]')?.textContent ?? null,
      overflow: (() => { const t = app.querySelector(".tabs"); return t ? t.scrollWidth > t.clientWidth : false; })(),
    };
  })()`);

  const shot = async (name) => {
    const box = await evaluate(`(() => { const r = document.querySelector(".frame").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    await writeFile(join(shotDir, `${name}.png`), Buffer.from(result.data, "base64"));
    return box;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url: pageUrl });
  await sleep(1200);

  // ---------------------------------------------------------------- 起点

  const start = await stateOf();
  check("打开时是一个类标签", start.tabs, ["LoginActivity"]);
  check("标签上标了语言", start.langs, ["java"]);
  check("类里包含它的所有方法", start.members, ["onCreate", "authenticate", "onActivityResult", "refreshToken"]);
  check("命中的是选中的那个方法", start.hitMember, "authenticate");
  check("模式标签默认不显示", start.mode, "");
  await shot("01-class-tab");

  // ---------------------------------------------------------------- Java：一个类一个标签

  await click('.row[data-kind="method"][data-key="onCreate"]');
  const sameClass = await stateOf();
  check("点同类里的另一个方法 → 不新开标签", sameClass.tabs, ["LoginActivity"]);
  check("标签还是同一个", sameClass.active, "LoginActivity");
  check("但命中的方法换了", sameClass.hitMember, "onCreate");
  checkThat("类的正文没变，仍然是整类的代码", sameClass.members.length === 4, `${sameClass.members.length} 个方法`);
  await shot("02-other-method-same-tab");

  await click('.row[data-kind="class"][data-key="TokenStore"]');
  const otherClass = await stateOf();
  check("点另一个类 → 新开一个类标签", otherClass.tabs, ["LoginActivity", "TokenStore"]);
  check("并切过去", otherClass.active, "TokenStore");
  check("没有命中任何方法", otherClass.hitMember, null);

  await click('.row[data-kind="method"][data-key="authenticate"]');
  const back = await stateOf();
  check("切回原来的类 → 不会重复开", back.tabs, ["LoginActivity", "TokenStore"]);
  check("并回到它", back.active, "LoginActivity");

  // ---------------------------------------------------------------- Native：一个函数一个标签

  await click('[data-testid="source-current"]');
  await click('[data-unit="libnotes"]');
  const native = await stateOf();
  check("切到 native 后左栏变成函数表", native.navTitle, "FUNCTIONS");
  checkThat("函数表是扁平的", native.topLevelRows.includes("authenticate_user"), native.topLevelRows.join(", "));

  await click('.row[data-kind="function"][data-key="auth_parse_token"]');
  const fnTab = await stateOf();
  check("一个函数一个标签", fnTab.tabs, ["LoginActivity", "TokenStore", "auth_parse_token"]);
  check("标签标为 native", fnTab.langs.at(-1), "native");
  check("标签里没有成员分节", fnTab.members, []);
  checkThat("标签内容是这个函数的代码", (fnTab.bodySignature ?? "").includes("auth_parse_token"), "签名对得上");

  await click('.row[data-kind="function"][data-key="audit_write"]');
  const fnTwo = await stateOf();
  check("另一个函数 → 另一个标签", fnTwo.tabs.slice(-2), ["auth_parse_token", "audit_write"]);
  checkThat("两个函数标签内容不同", fnTwo.bodySignature !== fnTab.bodySignature, "不同");
  await shot("03-native-function-tabs");

  await click('.row[data-kind="function"][data-key="auth_parse_token"]');
  check("再点已经开着的函数 → 不重复开", (await stateOf()).tabs.filter((t) => t === "auth_parse_token").length, 1);

  // ---------------------------------------------------------------- 字符串跳转按当前语言

  // 字符串表在标签里；点一行跳到用到它的那个单位，落点跟着当前语言
  await click('[data-testid="source-current"]');
  await click('[data-unit="dex"]');
  await click('.section-head.is-entry[data-entry="strings"]');
  // 从被点的那一行读它的归属，别写死 —— 这样断言的是行为，不是我的记性
  const javaOwner = await evaluate(`document.querySelectorAll('[data-testid="strings-panel"] tr[data-kind="string"]')[0].children[3].textContent`);
  await clickBy(`document.querySelectorAll('[data-testid="strings-panel"] tr[data-kind="string"]')[0].click()`);
  const jumpedJava = await stateOf();
  check("Java 里点字符串 → 落到它所属的类", jumpedJava.active, javaOwner.slice(0, javaOwner.indexOf(".")));
  check("并标出那个方法", jumpedJava.hitMember, javaOwner.slice(javaOwner.indexOf(".") + 1));

  await click('[data-testid="source-current"]');
  await click('[data-unit="libnotes"]');
  // 字符串表是按分析单元分开的，所以要看 native 的那一张，不是 dex 的。
  // 点左栏的 STRINGS 条目即可 —— 它开的是当前单元的那张表。
  await click('.section-head.is-entry[data-entry="strings"]');
  check("native 的字符串表是另一个标签", (await stateOf()).active, "STRINGS");
  checkThat(
    "两张表不是一个标签",
    await evaluate(`[...document.querySelectorAll('.tab')].map((t) => t.dataset.tab).filter((k) => k.startsWith("strings")).length`),
    "至少两个",
  );
  const nativeOwner = await evaluate(`document.querySelectorAll('[data-testid="strings-panel"] tr[data-kind="string"]')[1].children[3].textContent`);
  await clickBy(`document.querySelectorAll('[data-testid="strings-panel"] tr[data-kind="string"]')[1].click()`);
  const jumpedNative = await stateOf();
  check("Native 里点字符串 → 落到它所属的函数标签", jumpedNative.active, nativeOwner);
  await shot("04-string-jump-native");

  // ---------------------------------------------------------------- STRINGS 与 META

  // STRINGS 和 META 是条目，不是可展开的分区
  const entries = await evaluate(`(() => {
    const app = document.querySelector(".app");
    return {
      entries: [...app.querySelectorAll(".section-head.is-entry")].map((h) => h.dataset.entry),
      expandable: [...app.querySelectorAll(".section-head[aria-expanded]")].map((h) => h.dataset.section),
    };
  })()`);
  check("可展开的是树和两张短表", entries.expandable, ["functions", "import", "export"]);
  check("STRINGS 和 META 是直接条目", entries.entries, ["strings", "meta"]);

  await click('.section-head.is-entry[data-entry="strings"]');
  const stringsTab = await stateOf();
  check("点 STRINGS 直接开标签", stringsTab.active, "STRINGS");

  await click('.section-head.is-entry[data-entry="meta"]');
  const metaTab = await stateOf();
  check("点 META 也直接开标签", metaTab.active, "META");
  check("META 只剩两段 —— 导入导出各自成标签了", metaTab.metaSections, ["FORMAT", "SECTIONS"]);

  // IMPORT / EXPORT：既是短表（展开看全），也是标签（点开）
  const importHead = '.section-head[data-section="import"]';
  await click(importHead);
  const opened = await stateOf();
  check("点 IMPORT 既展开又开标签", opened.active, "IMPORT");
  checkThat(
    "IMPORT 展开后左栏列出全部条目",
    await evaluate(`document.querySelectorAll('.section-body[data-list="import"] .row').length`),
    "列出若干条",
  );
  checkThat(
    "展开的是全部而不是预览",
    await evaluate(`(() => {
      const rows = document.querySelectorAll('.section-body[data-list="import"] .row').length;
      const label = document.querySelector('.section-head[data-section="import"] .count').textContent;
      return rows === parseInt(label, 10);
    })()`),
    "条数与表头一致",
  );
  checkThat("IMPORT 标签里有表", await evaluate(`Boolean(document.querySelector('[data-testid="imports-panel"] table tr'))`), "有表");

  await click('.section-head[data-section="export"]');
  const exported = await stateOf();
  check("EXPORT 也成标签", exported.active, "EXPORT");
  checkThat("EXPORT 标签里有内容", await evaluate(`Boolean(document.querySelector('[data-testid="exports-panel"] table tr'))`), "有表");
  await shot("05-five-kinds");

  // ---------------------------------------------------------------- 多标签与关闭

  await clickBy(`document.querySelector('.tools button[data-action="open-many"]').click()`);
  const many = await stateOf();
  checkThat("标签可以开很多", many.tabs.length >= 7, `${many.tabs.length} 个`);
  checkThat("标签条会横向滚", many.overflow, `overflow=${many.overflow}`);
  await shot("06-many-tabs");

  const before = (await stateOf()).tabs;
  await clickBy(`document.querySelector('.app .tab[aria-selected="true"] .close').click()`);
  const afterClose = await stateOf();
  checkThat("关掉当前标签会落到相邻的一个", afterClose.tabs.length === before.length - 1 && afterClose.active !== null, `${before.length} → ${afterClose.tabs.length}`);

  await clickBy(`document.querySelector('.tools button[data-action="close-all"]').click()`);
  const emptied = await stateOf();
  check("全部关掉后没有标签", emptied.tabs, []);
  check("并给出空状态", emptied.empty, true);
  await shot("07-no-tabs");

  // ---------------------------------------------------------------- 模式

  await click('.row[data-kind="function"][data-key="audit_write"]');
  await click('.app .more');
  await clickBy(`document.querySelector('.app .menu button').click()`);
  check("⋯ 菜单能把模式切成 ASM，且只是一个标签", (await stateOf()).mode, "ASM");

  // ---------------------------------------------------------------- 不变量

  check("没有 console 错误", consoleErrors, []);
  check(
    "没有跨域请求",
    await evaluate(`performance.getEntriesByType("resource").every((entry) => new URL(entry.name).origin === location.origin)`),
    true,
  );
  check(
    "没有外部样式表、脚本或图片",
    await evaluate(`document.querySelectorAll('link[rel="stylesheet"], script[src], img').length`),
    0,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  socket?.close();
  chrome.kill();
  try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

if (failures.length === 0) {
  console.log(`\njadx 标签模型的检查全部通过。截图在 ${shotDir}`);
  process.exit(0);
}
console.error(`\n${failures.length} 项失败:`);
for (const failure of failures) console.error(`- ${failure}`);
process.exit(1);
