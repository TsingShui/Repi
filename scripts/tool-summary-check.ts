/**
 * What a tool call says about itself.
 *
 * The transcript is read by a person, and a tool call that renders as `{"fileId":"…","code":"…"}`
 * is a line that tells them nothing they wanted. Each tool's arguments have a natural reading —
 * a command, a path, a window — and this checks that each one is written that way, on one line,
 * and bounded.
 *
 *   node ./scripts/run-analysis-check.mjs tool-summary-check
 */
import { toolSummary } from "../src/lib/agent/tool-summary";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

const oneLine = (text: string) => !text.includes("\n");

{
  check(
    "a device command reads as the command",
    toolSummary("device", { command: "pm list packages -3" }) === "pm list packages -3",
  );
  check(
    "and says when it carries a script",
    toolSummary("device", { command: "su -c sh", input: "a\nb\nc" }) === "su -c sh (3 lines to stdin)",
    toolSummary("device", { command: "su -c sh", input: "a\nb\nc" }),
  );
  check(
    "a pull reads as a move",
    toolSummary("device_pull", { remote: "/sdcard/log.txt" }) === "/sdcard/log.txt",
  );
  check(
    "a push names what is going and where",
    toolSummary("device_push", { remote: "/data/local/tmp/x", source: "scripts/x.js" }) ===
      "scripts/x.js → /data/local/tmp/x",
  );
  check(
    "a read says which lines",
    toolSummary("read", { path: "notes/x.md", offset: 120, limit: 40 }) === "notes/x.md lines 120+, 40 of them",
    toolSummary("read", { path: "notes/x.md", offset: 120, limit: 40 }),
  );
  check("a write says how much", toolSummary("write", { path: "a.txt", text: "12345" }) === "a.txt (5 characters)");
  check(
    "an edit shows both sides, quoted",
    toolSummary("edit", { path: "a.js", old: "RETRY = 3", new: "RETRY = 5" }) === 'a.js: "RETRY = 3" → "RETRY = 5"',
    toolSummary("edit", { path: "a.js", old: "RETRY = 3", new: "RETRY = 5" }),
  );
  check(
    "a program reads as its size, because its text is in the message",
    toolSummary("run_js", { fileId: "f1", code: "a\nb\nc" }) === "3 lines of JavaScript",
  );
  check("listing binaries needs nothing said", toolSummary("list_binaries", {}) === "");
  check(
    "an unknown tool falls back to its arguments",
    toolSummary("new_tool", { anything: 1 }) === '{"anything":1}',
    toolSummary("new_tool", { anything: 1 }),
  );
  check("nothing to say is empty, not \"{}\"", toolSummary("read", {}) === "");
}

// The two properties a heading needs: one line, and short enough to be one.
{
  const long = {
    command: `su -c '${"x".repeat(400)}'`,
  };
  const summary = toolSummary("device", long);
  check("a long argument is on one line", oneLine(summary), JSON.stringify(summary.slice(0, 40)));
  check("and clipped", summary.length <= 160 && summary.endsWith("…"), `${summary.length} characters`);
  const code = toolSummary("run_js", { fileId: "f", code: "line\n".repeat(5_000) });
  check("a program's summary does not become the program", code.length < 40, code);
}

console.log(`\n${failures === 0 ? "all tool summary checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
