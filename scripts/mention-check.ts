/**
 * Mentions, checked where the rules are.
 *
 * `@` in a message box is easy to get subtly wrong: an email address that opens a file menu, a
 * query that swallows the rest of the sentence, a name that resolves to nothing and is silently
 * dropped, a file whose name has a space in it. None of that needs a browser to find — the parsing
 * is a pure function over a string, a caret and a file list, which is exactly how it is written
 * and how it is checked here.
 *
 * One property is checked rather than assumed, because it is the design: a mention hands over a
 * *reference*. The block the agent receives may contain a path and an id, never the file. A
 * feature that quietly inlined a 126 MB attachment into a prompt would be a much worse bug than a
 * menu that does not open.
 *
 *   node ./scripts/run-analysis-check.mjs mention-check
 */
import {
  insertMention,
  matchMentions,
  mentionBlock,
  mentionToken,
  parseMentions,
  type MentionTarget,
} from "../src/features/chat/mentions";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

const targets: readonly MentionTarget[] = [
  { id: "libfoo.so", name: "libfoo.so", kind: "attachment", bytes: 2048, fileId: "file-1" },
  {
    id: "lib/arm64-v8a/libbar.so",
    name: "libbar.so",
    kind: "derived",
    bytes: 9_400_000,
    sandboxPath: "/work/lib/arm64-v8a/libbar.so",
  },
  {
    id: "assets/notes with spaces.txt",
    name: "notes with spaces.txt",
    kind: "derived",
    bytes: 40,
    sandboxPath: "/work/assets/notes with spaces.txt",
  },
];

// 1. When a mention is being typed.
{
  const text = "look at @lib";
  const token = mentionToken(text, text.length);
  check("a `@` at the end of a word opens a mention", token?.query === "lib", token?.query ?? "none");
  check("the token knows where it starts", token?.start === 8, String(token?.start));

  const email = "write to adam@example.com";
  check(
    "an email address is not a mention",
    mentionToken(email, email.length) === null,
  );

  const middle = "look @lib and more";
  check(
    "typing past the mention closes it",
    mentionToken(middle, middle.length) === null,
  );
  check(
    "but the caret inside it still counts",
    mentionToken(middle, 9)?.query === "lib",
    mentionToken(middle, 9)?.query ?? "none",
  );

  const spaced = "look at @lib foo";
  check("a space ends the query", mentionToken(spaced, spaced.length) === null);

  const quoted = 'look at @"notes with';
  check(
    "a quoted name may contain spaces",
    mentionToken(quoted, quoted.length)?.query === "notes with",
    mentionToken(quoted, quoted.length)?.query ?? "none",
  );

  check("no `@`, no menu", mentionToken("look at libfoo.so", 17) === null);
}

// 2. What is offered, and in what order.
{
  const matches = matchMentions(targets, "bar");
  check("a match anywhere in the name is offered", matches[0]?.name === "libbar.so", matches[0]?.name ?? "none");
  const byPath = matchMentions(targets, "arm64");
  check("a match in the path is offered too", byPath[0]?.name === "libbar.so", byPath[0]?.name ?? "none");
  const all = matchMentions(targets, "");
  check("an empty query offers everything", all.length === 3, String(all.length));
  check("and nothing to offer says nothing", matchMentions(targets, "zzz").length === 0);
}

// 3. Insertion, including the name a message cannot spell without quotes.
{
  const text = "look at @lib";
  const token = mentionToken(text, text.length)!;
  const plain = insertMention(text, token, "libfoo.so");
  check("the name replaces what was typed", plain.text === "look at @libfoo.so ", plain.text);
  check("and the caret is past it, ready for the next word", plain.caret === plain.text.length, String(plain.caret));

  const spaced = insertMention("see @not", mentionToken("see @not", 8)!, "assets/notes with spaces.txt");
  check("a name with a space is quoted", spaced.text === 'see @"assets/notes with spaces.txt" ', spaced.text);

  const midSentence = insertMention("see @x now", mentionToken("see @x now", 6)!, "libfoo.so");
  check("a mention in the middle does not gain a space", midSentence.text === "see @libfoo.so now", midSentence.text);
}

// 4. What the message actually referenced.
{
  const text = "compare @libfoo.so with @lib/arm64-v8a/libbar.so and @libfoo.so again";
  const found = parseMentions(text, targets);
  check("each file is referenced once", found.length === 2, found.map((t) => t.id).join(", "));
  check("a quoted name resolves", parseMentions('read @"assets/notes with spaces.txt"', targets)[0]?.id === "assets/notes with spaces.txt");
  check("a bare name resolves", parseMentions("read notes with spaces.txt", targets).length === 0);
  check("a name nobody has is left alone", parseMentions("mail @someone", targets).length === 0);
}

// 5. What the agent is told: a reference, never the bytes.
{
  const block = mentionBlock(parseMentions("compare @libfoo.so and @lib/arm64-v8a/libbar.so", targets));
  check("the block names the files", (block ?? "").includes("libfoo.so") && (block ?? "").includes("libbar.so"));
  check("it gives the sandbox path", (block ?? "").includes("/work/lib/arm64-v8a/libbar.so"));
  check("and the id run_js takes", (block ?? "").includes("file-1"));
  check("it says how big they are", (block ?? "").includes("9.0 MB"), (block ?? "").split("\n")[2]);
  check("nothing mentions nothing", mentionBlock([]) === null);
  check(
    "and no file content can appear in it, because none was ever read",
    !(block ?? "").includes("send(") && (block ?? "").length < 500,
    `${(block ?? "").length} characters`,
  );
}

console.log(`\n${failures === 0 ? "all mention checks passed" : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
