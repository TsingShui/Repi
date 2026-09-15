import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9236", { timeout: 20000 });
const page = await browser.contexts()[0].newPage();
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://localhost:5173", { waitUntil: "load" });
await page.waitForTimeout(1200);
const seeded = await page.evaluate(async () => {
  const request = indexedDB.open("repi-workspace");
  const db = await new Promise((r) => (request.onsuccess = () => r(request.result)));
  const tx = db.transaction(["conversations"], "readwrite");
  tx.objectStore("conversations").clear();
  tx.objectStore("conversations").put({
    id: "c-lines", title: "Lines", updatedAt: Date.now(),
    lines: [{ kind: "you", text: "a question" }, { kind: "assistant", id: "a1", text: "an answer", state: "complete" }],
  });
  await new Promise((r) => (tx.oncomplete = r));
  const read = await new Promise((r) => {
    const get = db.transaction(["conversations"], "readonly").objectStore("conversations").getAll();
    get.onsuccess = () => r(get.result);
  });
  db.close();
  return read.map((c) => ({ id: c.id, lines: c.lines?.length }));
});
console.log("seeded:", JSON.stringify(seeded));
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(2500);
console.log("lines in DOM:", await page.evaluate(() => document.querySelectorAll(".line").length));
console.log("kinds:", await page.evaluate(() => [...document.querySelectorAll(".line")].map((n) => n.dataset.kind).join(",")));
console.log("active id:", await page.evaluate(() => localStorage.getItem("repi.active-conversation.v1")));
await page.close();
