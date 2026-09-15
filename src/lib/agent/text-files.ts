/**
 * Text files in the shared filesystem: reading a window of one, and changing one precisely.
 *
 * The agent's tools are about binaries, and a binary tool answers with a structure. Text is the
 * other shape of input — a script the agent wrote, a listing it produced, a log pulled off a
 * phone — and text has one property that a structure does not: it can be arbitrarily large
 * while the interesting part is arbitrarily small. So both operations here are windows rather
 * than whole files: read lines 120–160, or replace one exact string.
 *
 * Nothing here touches storage: bytes in, text out, and the rules that make the answers
 * predictable. The two callers are the sandbox (which already holds the bytes) and the tools
 * (which go and get one file), and they behave identically because they call this.
 */

/** The largest file `read` will open as text at all. */
export const TEXT_READ_LIMIT = 4 << 20;
/** The most text one page may carry, whatever the caller asked for. */
export const TEXT_WINDOW_LIMIT = 64 << 10;
/** Lines per page when the caller does not say. */
export const TEXT_PAGE_LINES = 2_000;
/** The most text one `write` may carry. */
export const TEXT_WRITE_LIMIT = 256 << 10;

/**
 * A path as the sandbox knows it: `/work/…` is where files live, and tools take the part after it.
 *
 * Three spellings arrive for the same file and all three mean it: the path the sandbox prints
 * (`/work/scripts/hook.js`), the path the storage keeps (`scripts/hook.js`), and — because
 * messages now contain `@name` — a leading `@` that a model picked up and repeated into an
 * argument. pi strips the same prefix from its tools for the same reason.
 */
export function normalizeVfsPath(input: string): string {
  let path = input.trim();
  if (path.startsWith("@")) path = path.slice(1);
  path = path.replace(/^\/+/, "");
  if (path === "work" || path.startsWith("work/")) path = path.slice("work".length).replace(/^\/+/, "");
  // `.` and `..` are the sandbox's problem, not a way out of it: a path is a name here, and a
  // name that could climb would be one that leaves the filesystem it names.
  return path
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
}

/**
 * Whether bytes are text at all.
 *
 * A NUL byte is the honest signal — no text encoding in use puts one in a document — and a run
 * of other control characters beyond tab and newline says the same thing more slowly. Both are
 * checked because `strings` output from a real binary sometimes has no NUL in the first page.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4_096);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

export interface TextWindow {
  readonly text: string;
  /** First line included, 1-based. */
  readonly startLine: number;
  /** Last line included, 1-based; 0 when the window is empty. */
  readonly endLine: number;
  /** How many lines the file has, or null when the caller asked for a window in a file too big to count. */
  readonly totalLines: number | null;
  readonly bytes: number;
  /** Lines were left out at the end because the window's byte ceiling was reached. */
  readonly truncated: boolean;
}

/** Splits text into lines, tolerant of CRLF and of a last line without a terminator. */
function lines(text: string): string[] {
  const split = text.split("\n");
  return split.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export interface ReadTextOptions {
  /** First line to include, 1-based. Defaults to 1. */
  readonly offset?: number;
  /** How many lines. Defaults to 2000, and the byte ceiling wins if it is smaller. */
  readonly limit?: number;
}

/**
 * One window of a text file.
 *
 * An offset past the end is not an error: it is a request for a part of the file that is not
 * there, and the honest answer to it is an empty window plus the size of the file.
 */
export function readTextWindow(bytes: Uint8Array, options: ReadTextOptions = {}): TextWindow {
  const decoder = new TextDecoder();
  const all = lines(decoder.decode(bytes));
  // A file ending in a newline has an empty final element that is not a line anyone wrote.
  if (all.length > 1 && all[all.length - 1] === "") all.pop();

  const offset = Math.max(1, Math.floor(options.offset ?? 1));
  const limit = Math.max(1, Math.floor(options.limit ?? TEXT_PAGE_LINES));

  const chosen: string[] = [];
  let used = 0;
  let truncated = false;
  for (let index = offset - 1; index < all.length && chosen.length < limit; index += 1) {
    const line = all[index] ?? "";
    const size = new TextEncoder().encode(line).length + 1;
    if (used + size > TEXT_WINDOW_LIMIT && chosen.length > 0) {
      truncated = true;
      break;
    }
    chosen.push(line);
    used += size;
  }

  return {
    text: chosen.join("\n"),
    startLine: chosen.length === 0 ? 0 : offset,
    endLine: chosen.length === 0 ? 0 : offset + chosen.length - 1,
    totalLines: all.length,
    bytes: bytes.length,
    truncated,
  };
}

export interface TextEdit {
  readonly text: string;
  /** Where the replacement landed, 1-based. */
  readonly line: number;
  /** Characters removed and added, so the caller can say what it did. */
  readonly removed: number;
  readonly added: number;
}

/**
 * One exact string replaced, or a refusal that says why.
 *
 * The rule is what makes an edit safe to offer: the string must occur exactly once. Not found
 * means the file is not what the caller thinks it is; found twice means the caller has to say
 * more — and both stop before writing anything, because a wrong guess here is a file quietly
 * changed in the wrong place, which is worse than a failed call.
 */
export function editText(text: string, old: string, replacement: string): TextEdit {
  if (old === "") {
    throw new Error("edit() needs the text to replace; an empty search would match everywhere.");
  }
  const first = text.indexOf(old);
  if (first === -1) {
    throw new Error(
      "That text is not in the file. Read it first — the file may have changed since it was read, " +
        "or the string may differ in whitespace.",
    );
  }
  if (text.indexOf(old, first + 1) !== -1) {
    throw new Error(
      "That text appears more than once, so the edit would be a guess. Include more of the " +
        "surrounding text so it identifies one place.",
    );
  }
  const edited = text.slice(0, first) + replacement + text.slice(first + old.length);
  const line = text.slice(0, first).split("\n").length;
  return { text: edited, line, removed: old.length, added: replacement.length };
}
