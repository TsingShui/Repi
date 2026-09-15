/**
 * `@` mentions: what the user points at, and what the agent is told about it.
 *
 * A mention is not decoration. Typing `@libfoo.so` puts a name in the message, and the model on
 * the other end has no way to open a name: it has a sandbox with paths in it and a file id per
 * attached binary. So a mention is resolved before the message is sent — the text stays exactly
 * as the user typed it, and the files it points at are described to the agent in the same terms
 * the agent's own tools use.
 *
 * The parsing is here rather than in the composer because it is the part with rules: which `@`
 * counts, what a name may contain, what happens to a name nobody has. The composer decides what
 * the menu looks like; this decides what the message means.
 */

/** One file the user can point at. */
export interface MentionTarget {
  /** What the message says: `@id`. */
  readonly id: string;
  /** What the menu shows first. */
  readonly name: string;
  /** A file the user attached, or something an engine produced. */
  readonly kind: "attachment" | "derived";
  readonly bytes: number;
  /** Where the sandbox sees it, when it is mounted: `/work/…`. */
  readonly sandboxPath?: string;
  /** The id `run_js` takes, for an attached binary. */
  readonly fileId?: string;
}

/** The `@…` token the caret is inside, if it is inside one. */
export interface MentionToken {
  /** Index of the `@`. */
  readonly start: number;
  /** Index just past the last typed character of the query. */
  readonly end: number;
  readonly query: string;
}

const WORD = /[\s(（[【，,;；]/;

/**
 * Finds the mention being typed at `caret`.
 *
 * An `@` only starts a mention when nothing word-like precedes it, which is what keeps an email
 * address in a sentence from opening a file menu, and the query may not contain whitespace:
 * `@lib foo` is a mention of `lib` followed by the word `foo`, not a mention of "lib foo".
 */
export function mentionToken(text: string, caret: number): MentionToken | null {
  // Look back for the nearest `@` that could be the start of one.
  const start = text.lastIndexOf("@", Math.max(0, caret - 1));
  if (start === -1) return null;
  const before = text[start - 1];
  if (before !== undefined && !WORD.test(before)) return null;

  const typed = text.slice(start + 1, caret);
  const quoted = typed.startsWith('"');
  if (quoted) {
    // A quoted name may contain spaces, and closes when the user types the closing quote.
    if (typed.slice(1).includes('"')) return null;
    return { start, end: caret, query: typed.slice(1) };
  }
  if (/\s/.test(typed)) return null;
  // The caret is inside a mention only if nothing but the query follows it.
  return { start, end: caret, query: typed };
}

/**
 * The targets to offer, best first.
 *
 * Ordered by how the user is thinking rather than by what the files are: a name that starts with
 * what was typed beats one that contains it, which beats a match somewhere in the path. Ties go
 * to the shorter name, because shorter is what people type.
 */
export function matchMentions(
  targets: readonly MentionTarget[],
  query: string,
  limit = 8,
): readonly MentionTarget[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return targets.slice(0, limit);

  const scored: { target: MentionTarget; score: number }[] = [];
  for (const target of targets) {
    const name = target.name.toLowerCase();
    const id = target.id.toLowerCase();
    let score: number;
    if (name.startsWith(needle)) score = 0;
    else if (name.includes(needle)) score = 1;
    else if (id.includes(needle)) score = 3;
    else continue;
    scored.push({ target, score });
  }
  scored.sort((a, b) => a.score - b.score || a.target.name.length - b.target.name.length);
  return scored.slice(0, limit).map((entry) => entry.target);
}

/** A name the message can carry unquoted. */
function needsQuotes(id: string): boolean {
  return /\s/.test(id) || id.includes('"');
}

/**
 * Replaces the token with the chosen name, and says where the caret goes.
 *
 * The caret lands after the inserted text plus a space when the token was at the end of the
 * message: a mention is almost always a word the user keeps typing after, and leaving the caret
 * glued to the name is the difference between finishing a sentence and correcting one.
 */
export function insertMention(
  text: string,
  token: MentionToken,
  id: string,
): { text: string; caret: number } {
  const written = needsQuotes(id) ? `@"${id}"` : `@${id}`;
  const rest = text.slice(token.end);
  const trail = rest === "" ? " " : "";
  return {
    text: `${text.slice(0, token.start)}${written}${trail}${rest}`,
    caret: token.start + written.length + trail.length,
  };
}

/** The mentions text carries, resolved against what actually exists. */
export function parseMentions(
  text: string,
  targets: readonly MentionTarget[],
): readonly MentionTarget[] {
  const byName = new Map<string, MentionTarget>();
  for (const target of targets) {
    // Both spellings resolve: what the menu writes, and the bare name someone typed by hand.
    byName.set(target.id.toLowerCase(), target);
    if (!byName.has(target.name.toLowerCase())) byName.set(target.name.toLowerCase(), target);
  }

  const found: MentionTarget[] = [];
  const seen = new Set<string>();
  // Quoted first: a quoted name may contain spaces, so an unquoted scan cannot see its end.
  for (const match of text.matchAll(/@"([^"]*)"|@([^\s@]+)/g)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (raw === "") continue;
    const target = byName.get(raw.toLowerCase());
    // A name nobody has is left alone: it is text the user typed, not a broken reference.
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    found.push(target);
  }
  return found;
}

/** Bytes, as the one line the agent reads. */
function describe(target: MentionTarget): string {
  const size = target.bytes >= 1 << 20
    ? `${(target.bytes / (1 << 20)).toFixed(1)} MB`
    : target.bytes >= 1024
      ? `${Math.round(target.bytes / 1024)} KB`
      : `${target.bytes} bytes`;

  if (target.kind === "attachment") {
    const id = target.fileId ? `, fileId for run_js: ${target.fileId}` : "";
    return `- ${target.name} — ${size}, the attached binary${id}`;
  }
  const path = target.sandboxPath ? `at ${target.sandboxPath} in the sandbox` : "in the sandbox";
  return `- ${target.id} — ${size}, ${path}`;
}

/**
 * What the agent is told, or null when the message mentions nothing.
 *
 * Written as an addition to the user's message rather than as a system instruction, because that
 * is what it is: the user pointed at these files in this message, and the note says where they
 * are so the next program can open them.
 */
export function mentionBlock(mentions: readonly MentionTarget[]): string | null {
  if (mentions.length === 0) return null;
  const lines = mentions.map(describe).join("\n");
  const first = mentions.length === 1 ? "The message points at this file" : "The message points at these files";
  return `${first}:\n${lines}\n(Paths above are what the sandbox sees; open them with run_js rather than guessing.)`;
}
