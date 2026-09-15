/**
 * Text files in the shared filesystem, checked where the rules are.
 *
 * Two things make this feature worth checking rather than trying by hand. Paging has boundaries —
 * the last line, an offset past the end, a window cut by the byte ceiling — and an edit has a
 * contract: the string occurs exactly once, or nothing is written. Both are pure functions over
 * bytes and text, so both are checked here, and the sandbox's own copy of the same rules is
 * exercised in `sandbox-check` where a real program calls it.
 *
 *   node ./scripts/run-analysis-check.mjs text-files-check
 */
import {
  editText,
  looksBinary,
  normalizeVfsPath,
  readTextWindow,
  TEXT_WRITE_LIMIT,
} from "../src/lib/agent/text-files";
import { createVfsFunctions } from "../src/lib/agent/vfs-functions";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

// 1. Paths: one file, three spellings, all of them meant.
{
  check("a bare path stays", normalizeVfsPath("scripts/hook.js") === "scripts/hook.js");
  check("the sandbox's path is the same file", normalizeVfsPath("/work/scripts/hook.js") === "scripts/hook.js");
  check("a leading @ from a mention is not part of the name", normalizeVfsPath("@scripts/hook.js") === "scripts/hook.js");
  check("and neither is a leading slash", normalizeVfsPath("/scripts/hook.js") === "scripts/hook.js");
  check(
    "a path cannot climb out",
    normalizeVfsPath("../../etc/passwd") === "etc/passwd",
    normalizeVfsPath("../../etc/passwd"),
  );
  check("empty parts collapse", normalizeVfsPath("a//b/./c") === "a/b/c");
}

// 2. Text, and not text.
{
  check("plain text is text", !looksBinary(bytes("hello\nworld\n")));
  check("a NUL byte is not", looksBinary(bytes("hello\0world")));
  check("nor is a page of control bytes", looksBinary(new Uint8Array(512).fill(1)));
  check("an empty file is text", !looksBinary(new Uint8Array(0)));
}

// 3. Paging: what a window promises, at its edges.
{
  const file = bytes(Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n"));
  const first = readTextWindow(file);
  check("a small file comes back whole", first.startLine === 1 && first.endLine === 500 && first.totalLines === 500);
  check("with nothing cut", !first.truncated);

  const window = readTextWindow(file, { offset: 120, limit: 3 });
  check("an offset reads from there", window.text === "line 120\nline 121\nline 122", window.text.replace(/\n/g, "|"));
  check("and says which lines they were", window.startLine === 120 && window.endLine === 122);
  check("while still knowing the size", window.totalLines === 500);

  const past = readTextWindow(file, { offset: 900 });
  check("past the end is an empty window, not an error", past.startLine === 0 && past.text === "");
  check("that still reports the file", past.totalLines === 500);

  const trailing = readTextWindow(bytes("a\nb\n"));
  check("a trailing newline is not a line", trailing.totalLines === 2, String(trailing.totalLines));
  const crlf = readTextWindow(bytes("a\r\nb\r\n"));
  check("CRLF does not carry its carriage return", crlf.text === "a\nb", crlf.text.replace(/\r/g, "\\r"));

  const long = bytes(Array.from({ length: 200 }, () => "x".repeat(1024)).join("\n"));
  const cut = readTextWindow(long, { offset: 1, limit: 200 });
  check("the byte ceiling wins over the line count", cut.truncated && cut.endLine < 200, `ended at ${cut.endLine}`);
}

// 4. Editing: exactly once, or nothing.
{
  const file = "one\ntwo\nthree\n";
  const edited = editText(file, "two", "TWO");
  check("a unique string is replaced", edited.text === "one\nTWO\nthree\n", JSON.stringify(edited.text));
  check("and the line is reported", edited.line === 2, String(edited.line));
  check("with the size of the change", edited.removed === 3 && edited.added === 3);
  check("deleting is allowed", editText(file, "two\n", "").text === "one\nthree\n");

  let missing = "";
  try {
    editText(file, "four", "x");
  } catch (error) {
    missing = error instanceof Error ? error.message : "";
  }
  check("a string that is not there is refused", /not in the file/i.test(missing), missing.slice(0, 60));

  let ambiguous = "";
  try {
    editText("a\na\n", "a", "b");
  } catch (error) {
    ambiguous = error instanceof Error ? error.message : "";
  }
  check("a string that occurs twice is refused", /more than once/i.test(ambiguous), ambiguous.slice(0, 60));

  let empty = "";
  try {
    editText(file, "", "x");
  } catch (error) {
    empty = error instanceof Error ? error.message : "";
  }
  check("an empty search is refused", /empty search/i.test(empty), empty.slice(0, 60));
}

// 5. The same rules, inside a program.
{
  const written = new Map<string, Uint8Array>();
  const shared = new Map<string, Uint8Array>([["notes/readme.md", bytes("# Notes\nsecond line\n")]]);
  const files = createVfsFunctions({ written, shared });

  const page = files.read(["notes/readme.md"]);
  check("a program reads a shared file", page.includes("second line"), page.replace(/\n/g, "|"));
  // The text alone: a header would be the first thing a program's own parsing trips over.
  check(
    "and gets the file's text with no header mixed in",
    page === "# Notes\nsecond line" && !/Showing/.test(page),
    JSON.stringify(page),
  );

  const wrote = files.write(["out/listing.txt", "alpha\nbeta\n"]);
  check("a program writes into the session's map", wrote.bytes === 11 && written.has("out/listing.txt"));
  check("which is what the host keeps afterwards", text(written.get("out/listing.txt")!) === "alpha\nbeta\n");
  check("written files are readable back", files.read(["out/listing.txt"]).includes("alpha"));

  const edited = files.edit(["out/listing.txt", "beta", "GAMMA"]);
  check("and editable in place", edited.line === 2 && text(written.get("out/listing.txt")!) === "alpha\nGAMMA\n");

  const overLimit = "x".repeat(TEXT_WRITE_LIMIT + 1);
  let refused = "";
  try {
    files.write(["out/big.txt", overLimit]);
  } catch (error) {
    refused = error instanceof Error ? error.message : "";
  }
  check("a write over the ceiling is refused", /over the limit/i.test(refused), refused.slice(0, 60));

  let unknown = "";
  try {
    files.read(["nowhere.txt"]);
  } catch (error) {
    unknown = error instanceof Error ? error.message : "";
  }
  check("reading a file that is not there names the way to find one", /ls\(\)/.test(unknown), unknown.slice(0, 60));

  let binary = "";
  try {
    shared.set("lib/arm64-v8a/libfoo.so", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    files.read(["lib/arm64-v8a/libfoo.so"]);
  } catch (error) {
    binary = error instanceof Error ? error.message : "";
  }
  check("a binary is refused with the engine to use instead", /rasc\(\) or kuna\(\)/.test(binary), binary.slice(0, 70));

  const nested = files.read(["/work/notes/readme.md"]);
  check("the sandbox's own path spelling works too", nested.includes("second line"));
}

console.log(`\n${failures === 0 ? "all text file checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
