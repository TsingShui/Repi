/**
 * The device dialog's three silent paths, checked without a phone.
 *
 * What made "connect" look broken was not the USB stack: it was that closing Chrome's picker,
 * opening it when the phone offers no ADB interface, and WebUSB being absent all ended with the
 * dialog exactly as it was. None of those needs hardware to reproduce — a stubbed
 * `navigator.usb` is enough — so this drives the real dialog and asserts that each one now
 * says something.
 *
 * A browser already listening for CDP is required, and a dev server:
 *
 *   npm run dev -- --host 0.0.0.0
 *   chrome --headless=new --remote-debugging-port=9230 --user-data-dir=/tmp/cdp about:blank
 *   node scripts/device-check.mjs http://localhost:5173
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const browser = await chromium.connectOverCDP(process.env.CDP ?? "http://localhost:9230", {
  timeout: 20_000,
});

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

/**
 * Opens the dialog with a stubbed `navigator.usb`.
 *
 * The stub is built *inside* the page from a mode string: an init script's argument has to be
 * serializable, and an object with methods is not — it arrives as `{}`, which fails in a way
 * that looks like the application's fault.
 */
async function openDialog(mode) {
  const page = await browser.contexts()[0].newPage();
  await page.addInitScript((kind) => {
    if (kind === "none") {
      Object.defineProperty(navigator, "usb", { configurable: true, value: undefined });
      return;
    }
    const usb = {
      getDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    };
    if (kind === "cancel") {
      usb.requestDevice = async () => {
        throw new DOMException("No device selected.", "NotFoundError");
      };
    }
    if (kind === "hang") usb.requestDevice = () => new Promise(() => {});
    Object.defineProperty(navigator, "usb", { configurable: true, value: usb });
  }, mode);
  await page.setViewportSize({ width: 520, height: 1000 });
  await page.goto(base, { waitUntil: "load" });
  await page.click('[aria-label="Open conversation history"]');
  await page.click(".sidebar-device");
  await page.waitForSelector("dialog.device-dialog", { timeout: 15_000 });
  await page.waitForTimeout(250);
  return page;
}

// 1. The picker was closed, or came up empty because the phone shows no ADB interface.
{
  const page = await openDialog("cancel");
  await page.click(".device-request");
  await page.waitForTimeout(700);
  const text = await page.locator("dialog.device-dialog").innerText();
  check(
    "an empty or closed picker explains itself",
    /No device was chosen/.test(text) && /file transfer or PTP/.test(text) && /usbipd|WSL/.test(text),
    text.split("\n").find((line) => line.startsWith("No device"))?.slice(0, 80) ?? "(nothing said)",
  );
  check(
    "and the button is usable again",
    (await page.locator(".device-request").innerText()).includes("Connect an Android device"),
  );
  await page.close();
}

// 2. The two waits: Chrome's picker, then the phone's authorization prompt.
{
  const page = await openDialog("hang");
  await page.click(".device-request");
  await page.waitForTimeout(500);
  const text = await page.locator("dialog.device-dialog").innerText();
  check(
    "the wait names both halves of it",
    /Waiting for the picker/.test(text) && /Allow USB debugging/.test(text),
  );
  await page.close();
}

// 3. No WebUSB at all: not a hang, a sentence about where WebUSB works.
{
  const page = await openDialog("none");
  const text = await page.locator("dialog.device-dialog").innerText();
  check("a browser without WebUSB says so", /WebUSB is unavailable/.test(text));
  check("and offers no button that cannot work", (await page.locator(".device-request").count()) === 0);
  await page.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "all device checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
