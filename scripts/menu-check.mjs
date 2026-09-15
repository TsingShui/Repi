/**
 * The dropdowns, checked against the geometry that used to break them.
 *
 * Both menus live in the composer, which is at the bottom of the window: a fixed downward menu
 * there opens into the few pixels below the box and is cut off. That is a property of rectangles,
 * so it is checked as one — the trigger's position, the viewport, and where the menu ends up —
 * rather than by looking at a screenshot and deciding it seems fine.
 *
 * The providers are seeded in the workspace database before the app loads, because the menu's
 * height is what makes the difference and an empty menu has none.
 *
 *   npm run dev -- --host 0.0.0.0
 *   chrome --headless=new --remote-debugging-port=9231 --user-data-dir=/tmp/cdp about:blank
 *   node scripts/menu-check.mjs
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const browser = await chromium.connectOverCDP(process.env.CDP ?? "http://localhost:9231", {
  timeout: 20_000,
});

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

const page = await browser.contexts()[0].newPage();
await page.goto(base, { waitUntil: "load" });

// A provider with enough models that its menu has to make a decision, and one model that thinks
// so the second menu exists at all.
await page.evaluate(async () => {
  const request = indexedDB.open("repi-workspace");
  const database = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!database.objectStoreNames.contains("providers")) {
    database.close();
    return;
  }
  const models = Array.from({ length: 24 }, (_, index) => `model-${String(index).padStart(2, "0")}`);
  const transaction = database.transaction(["providers"], "readwrite");
  transaction.objectStore("providers").put({
    id: "seed-provider",
    kind: "custom",
    name: "Seeded",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "",
    models: [...models, "thinks-a-lot"],
    reasoningModels: ["thinks-a-lot"],
    createdAt: Date.now(),
  });
  await new Promise((resolve) => (transaction.oncomplete = resolve));
  database.close();
});

await page.setViewportSize({ width: 900, height: 800 });
await page.reload({ waitUntil: "load" });
await page.click(".model-selector-trigger");
await page.waitForSelector(".model-menu", { timeout: 10_000 });
await page.waitForTimeout(150);

/**
 * Where a menu actually is: its own box, the room the trigger had on each side, and whether its
 * list scrolls.
 *
 * The room is measured here rather than recomputed from the app's rule, so the checks can ask
 * the only questions that matter from outside — did it flip when it had to, and did it stay in
 * the window — without restating the geometry and being wrong in the same way twice.
 */
const geometry = async (menuSelector, triggerSelector) =>
  page.evaluate(
    ([menuS, triggerS]) => {
      const menu = document.querySelector(menuS);
      const trigger = document.querySelector(triggerS);
      const rect = menu.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const scroll = menu.querySelector(".model-menu-scroll") ?? menu;
      return {
        direction: menu.dataset.placement ?? "(unset)",
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        viewport: window.innerHeight,
        roomBelow: Math.round(window.innerHeight - triggerRect.bottom),
        roomAbove: Math.round(triggerRect.top),
        contentHeight: scroll.scrollHeight,
        visibleHeight: scroll.clientHeight,
      };
    },
    [menuSelector, triggerSelector],
  );

{
  const menu = await geometry(".model-menu", ".model-selector-trigger");
  const fitsBelow = menu.roomBelow >= menu.height + 20;
  check(
    "a menu opens where its content fits",
    (menu.direction === "down") === fitsBelow || menu.direction === "up",
    `${menu.direction} height=${menu.height} room below=${menu.roomBelow} above=${menu.roomAbove}`,
  );
  check(
    "it does not flip upward when there is room below",
    !(menu.direction === "up" && fitsBelow),
    `${menu.direction} room below=${menu.roomBelow} height=${menu.height}`,
  );
  check(
    "and it is entirely on screen",
    menu.top >= 0 && menu.bottom <= menu.viewport,
    `top=${menu.top} bottom=${menu.bottom} viewport=${menu.viewport}`,
  );
}

// A menu that measures itself after being capped shrinks a row per frame. The symptom is a menu
// that opens and is then suddenly one line tall, so the check is a second look a moment later.
{
  const settled = await geometry(".model-menu", ".model-selector-trigger");
  await page.waitForTimeout(500);
  const later = await geometry(".model-menu", ".model-selector-trigger");
  check(
    "the menu keeps its size once open",
    later.height === settled.height && later.visibleHeight === settled.visibleHeight,
    `${settled.height}px then ${later.height}px`,
  );
  check(
    "and it is showing more than one row",
    later.visibleHeight > 120,
    `list=${later.visibleHeight}px of ${later.contentHeight}px`,
  );
}

// Now the flip itself: a window whose composer sits below the middle has more room above than
// below, and a menu that insists on opening downward lands off the bottom of the screen.
await page.setViewportSize({ width: 900, height: 420 });
await page.waitForTimeout(200);
{
  const menu = await geometry(".model-menu", ".model-selector-trigger");
  const needsUp = menu.roomBelow < menu.height && menu.roomAbove > menu.roomBelow;
  check(
    "a window with no room below opens the menu upward",
    !needsUp || menu.direction === "up",
    `${menu.direction} room below=${menu.roomBelow} above=${menu.roomAbove} height=${menu.height}`,
  );
  check(
    "and the upward menu is on screen",
    menu.top >= 0 && menu.bottom <= menu.viewport,
    `top=${menu.top} bottom=${menu.bottom} viewport=${menu.viewport}`,
  );
}

// The case that matters when there is not enough room either way: the menu must stay inside the
// window and scroll, not overflow.
await page.setViewportSize({ width: 640, height: 360 });
await page.waitForTimeout(200);
{
  const menu = await geometry(".model-menu", ".model-selector-trigger");
  check(
    "a short window squeezes the menu instead of overflowing it",
    menu.top >= 0 && menu.bottom <= menu.viewport + 1,
    `top=${menu.top} bottom=${menu.bottom} viewport=${menu.viewport} height=${menu.height}`,
  );
  check(
    "and the list still scrolls",
    menu.visibleHeight < menu.contentHeight,
    `visible=${menu.visibleHeight} content=${menu.contentHeight}`,
  );
}

// The thinking control: present for a model that thinks, absent for one that does not.
await page.setViewportSize({ width: 900, height: 800 });
await page.waitForTimeout(200);
{
  check("no thinking control before a model is chosen", (await page.locator(".thinking-trigger").count()) === 0);
  await page.click(".model-option >> nth=0");
  await page.waitForTimeout(250);
  check(
    "a model that does not think offers no levels",
    (await page.locator(".thinking-trigger").count()) === 0,
  );

  await page.click(".model-selector-trigger");
  await page.waitForSelector(".model-menu");
  await page.click(".model-option:has-text('thinks-a-lot')");
  await page.waitForTimeout(300);
  check("a model that thinks gets the control", (await page.locator(".thinking-trigger").count()) === 1);

  await page.click(".thinking-trigger");
  await page.waitForSelector(".thinking-menu");
  const levels = await page.locator(".thinking-option").allInnerTexts();
  check(
    "with the levels that model accepts",
    levels.join(",") === "off,minimal,low,medium,high",
    levels.join(", "),
  );
  const menu = await geometry(".thinking-menu", ".thinking-trigger");
  check(
    "and it is on screen too",
    menu.top >= 0 && menu.bottom <= menu.viewport,
    `${menu.direction} top=${menu.top} bottom=${menu.bottom}`,
  );
  check(
    "and not flipped, because this one has room below",
    menu.direction === "down" && menu.roomBelow > menu.height,
    `${menu.direction} room below=${menu.roomBelow} height=${menu.height}`,
  );

  await page.click(".thinking-option:has-text('high')");
  await page.waitForTimeout(200);
  const stored = await page.evaluate(async () => {
    const request = indexedDB.open("repi-workspace");
    const database = await new Promise((resolve) => (request.onsuccess = () => resolve(request.result)));
    const transaction = database.transaction(["conversations"], "readonly");
    const store = transaction.objectStore("conversations");
    const all = await new Promise((resolve) => {
      const get = store.getAll();
      get.onsuccess = () => resolve(get.result);
    });
    database.close();
    return all.filter((conversation) => conversation.thinkingLevel).map((c) => c.thinkingLevel);
  });
  check("the choice is remembered with the conversation", stored.includes("high"), stored.join(", "));
  check("and it reads back as the current level", (await page.locator(".thinking-trigger").innerText()).includes("high"));
}

// A refresh is where this went wrong once: the conversation came back from storage before the
// provider list did, the answer was computed against an empty list, and nothing asked again.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(800);
check(
  "the thinking control survives a reload",
  (await page.locator(".thinking-trigger").count()) === 1,
);
check(
  "and shows the level the conversation remembered",
  (await page.locator(".thinking-trigger").innerText()).includes("high"),
  (await page.locator(".thinking-trigger").count()) === 1
    ? await page.locator(".thinking-trigger").innerText()
    : "(no control)",
);

// Clean up the seeded provider so a real browser profile is not left holding it.
await page.evaluate(async () => {
  const request = indexedDB.open("repi-workspace");
  const database = await new Promise((resolve) => (request.onsuccess = () => resolve(request.result)));
  const transaction = database.transaction(["providers", "conversations"], "readwrite");
  transaction.objectStore("providers").delete("seed-provider");
  transaction.objectStore("conversations").clear();
  await new Promise((resolve) => (transaction.oncomplete = resolve));
  database.close();
});
await page.close();
// The browser belongs to whoever launched it: `connectOverCDP` means this script is a guest, and
// closing a guest's host shuts down the instance the next run needs.

console.log(`\n${failures === 0 ? "all menu checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
