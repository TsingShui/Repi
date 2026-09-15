/**
 * Drives the `?probe` screen in a real browser over CDP.
 *
 * The one path a Node check cannot reach is a module Worker with `FileReaderSync` over a real
 * file, plus `fetch` for the engines and their specs. This runs it without a person clicking:
 * it needs a browser already listening for CDP (Chromium, Chrome or Edge), and a dev server.
 *
 *   npm run dev -- --host 0.0.0.0
 *   chrome --headless=new --remote-debugging-port=9223 --user-data-dir=/tmp/cdp about:blank
 *   node scripts/probe-run.mjs http://localhost:5173
 *
 * `?probe=<url>` is what makes it unattended: the page fetches its own fixture. The APK case
 * wants a served archive, e.g. a symlink under `public/` (`ln -s /path/app.apk public/dev-fixture.apk`).
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const cases = [
  ["kuna", `${base}/?probe=/kuna/fixtures/sample.elf`],
  ["rasc", `${base}/?probe=/dev-fixture.apk`],
];

const browser = await chromium.connectOverCDP(process.env.CDP ?? "http://localhost:9223");
const context = browser.contexts()[0] ?? (await browser.newContext());

for (const [label, url] of cases) {
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 300)}`);
  });

  await page.goto(url, { waitUntil: "load" });
  let verdict = "timed out";
  try {
    await page.waitForFunction(
      () => document.title === "probe: ok" || document.title === "probe: fail",
      null,
      { timeout: 300_000 },
    );
    verdict = await page.title();
  } catch {
    /* reported below */
  }
  const output = await page.locator("pre").innerText().catch(() => "(no output)");
  console.log(`\n########## ${label}: ${verdict}`);
  console.log(output.trim());
  for (const problem of problems.slice(0, 8)) console.log(`  ! ${problem}`);
  await page.close();
}

await browser.close();
