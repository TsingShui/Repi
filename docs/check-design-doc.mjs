/**
 * Keeps the design document honest about the implementation it describes.
 *
 * The document is prose, so nothing here can prove it correct. What it can do is
 * catch the two ways it went stale silently during this build: it cites a number
 * the check suite no longer produces, or it still describes a decision that was
 * reversed. Both happened, and both were caught by a person reading rather than
 * by a check.
 *
 * The assertion count is read from what the smoke run actually produced, so it
 * cannot be updated to a number that is merely plausible.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const docPath = join(repoRoot, "docs/repi-decompile-design.md");
const countsPath = join(repoRoot, ".smoke/assertions.json");

const failures = [];
let passed = 0;

function checkThat(label, ok, detail) {
  if (ok) passed += 1;
  else failures.push(`${label}: ${detail}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label} ${detail}`);
}

const scanned = [
  docPath,
  join(repoRoot, "docs/repi-design.md"),
  join(repoRoot, "README.md"),
];

const doc = await readFile(docPath, "utf8");
const others = await Promise.all(scanned.slice(1).map((path) => readFile(path, "utf8")));
const all = [doc, ...others].join("\n");

/**
 * Vocabulary that belongs to a superseded decision. Each entry names what
 * replaced it, so a failure says what to write instead of only what to delete.
 */
const retired = [
  [/\bC \| ASM\b/, "the segmented mode control was replaced by a label plus Cmd/Ctrl+Shift+C"],
  [/\bthree labelled sections\b/, "META is two sections; imports and exports became tabs"],
  [/\bselect the views\b/, "there are no numbered views; tabs are opened from the column"],
  [/\bclosable view\b/, "tabs are what close"],
  [/CODE is a view rather than a document/, "CODE is a document: a class or a function"],
  [/\b128 behaviours\b/, "the assertion count is read from the smoke run, not written by hand"],
  // Layout drift: the document described the pre-skin bar and a fixed view strip
  // long after both were replaced, and nothing caught it.
  [/\b52px tall\b/, "the bar is 36px under a fine pointer and 44px under a coarse one"],
  [/CODE\s+│\s+STRINGS\s+│\s+META/, "the strip holds whichever tabs are open, not three fixed views"],
  [/\bNothing selected\b/, "the empty state reads No tab open"],
  [/Target size\s*\|\s*Notes/, "the sizes are density-dependent, not one column of targets"],
  [/live local-analysis trace/, "the home footer was removed"],
  [/tabs that name a view rather than a document/, "tabs hold documents: a class or a function"],
  [/META page carrying format facts, sections and imports/, "imports are their own tab"],
  // The reference-count phase reversed three sentences at once, and nothing in the checks
  // noticed: the document denied cross-references, a filled column and a jump while all three
  // shipped. Each is retired with what replaced it, so a later edit cannot quietly restore a
  // claim the code contradicts.
  [/\breports no cross-references\b/, "the census answers them: strings --xrefs counts the methods that use each string"],
  [/XREFS column reads zero/, "the column is filled from one census pass; a counted zero is not a dash"],
  [/a row does not jump/, "a row with no owner asks the engine and opens the class it names, marked"],
  [/per-function tabs/, "a native function already has its own tab"],
  [/Coming [Ss]oon/, "the Agent surface is not advertised until it exists"],
  // The second engine arrived and the documents still described it as pending.
  [/because Rasc does not exist yet/, "Rasc is wired in; the mock serves what no real engine claims"],
  [/until Rasc exists/, "containers are analysed by Rasc now"],
  [/Still absent: Rasc/, "Rasc is no longer absent"],
  // The application was extracted from the Pi package's repository, where it lived under a
  // directory named for the idea rather than the product. The path name is retired: the
  // documents must say Repi and the repository, not where the source used to sit.
  [/edge-compute/, "the application is Repi in a repository of its own; the internal path name is retired"],
  // The Rasc module stopped being committed and the repository now carries no engine artifact, so
  // the documents must not promise a clone an engine it would have to build. Both documents made
  // the claim in bold; a looser pattern here matched a bullet marker at the top of one section
  // through to a bold paragraph in another, which is a check that fails for the wrong reason.
  [/\*\*(is )?committed\*\*/, "engine artifacts are build output: a clone runs build:rasc, and the deploy workflow builds both"],
];

/*
 * Sentences that talk about the history are allowed to name the old thing — the
 * document should be able to say what it used to say and why that changed.
 * Everything else is scanned.
 */
const current = all
  .split(/(?<=[.!?])\s+/)
  .filter((sentence) => !/\b(earlier version|used to|was removed|replaced)\b/i.test(sentence))
  .join(" ");

for (const [pattern, why] of retired) {
  checkThat(`doc: no longer says ${pattern.source}`, !pattern.test(current), why);
}

// The density mechanism is a deviation from the obvious CSS and it was recorded
// only in a code comment. If the document stops explaining it, that is a defect.
checkThat(
  "doc: records how density is chosen",
  /data-pointer/.test(doc) && /matchMedia/.test(doc),
  "the pointer signal and the attribute the CSS keys off must be written down",
);
checkThat(
  "doc: records the fallback when the pointer is unknown",
  /cannot be identified/.test(doc),
  "the fallback is the touch size and that is the part that matters on a device",
);
checkThat(
  "doc: says the trackpad question is unverified",
  /(pointer: fine)[^.]*unverified|unverified/i.test(doc),
  "an untested behaviour must be marked as untested, not asserted",
);

checkThat(
  "doc: cites a target size that depends on the pointer",
  /coarse pointer/.test(doc) && /fine pointer/.test(doc),
  "the 44px rule is conditional and the document must say so",
);

let counts = null;
let didNotRun = false;
try {
  counts = JSON.parse(await readFile(countsPath, "utf8"));
} catch {
  failures.push(
    `doc: ${countsPath} is missing — run \`npm run verify\` so the document can be checked against a real run`,
  );
}

if (counts) {
  const cited = doc.match(/asserts (\d+) behaviours/);
  checkThat("doc: cites an assertion count at all", cited !== null, "add the number the suite reports");
  if (cited && !counts.blocked) {
    checkThat(
      "doc: the cited assertion count is the one the suite produces",
      Number(cited[1]) === counts.total,
      `document says ${cited[1]}, the smoke run produced ${counts.total}`,
    );
  }
  if (counts.blocked) {
    // Louder than a pass, quieter than a failure: nothing was verified, and the count is not a
    // claim about the document because no suite produced it. Say how many assertions went
    // unchecked so a partial run cannot quietly lower what the suite claims to cover.
    console.log(
      `     skip: the smoke suite could not run (${counts.blocked}) — ` +
        `${counts.total} assertion(s) unchecked, the document's figure not compared`,
    );
    didNotRun = true;
  } else {
    checkThat("doc: the suite it cites passed", counts.failed === 0, `${counts.failed} failing`);
  }
  if (counts.skipped > 0) {
    console.log(
      `     note: ${counts.skipped} checks were skipped (the Kuna engine is not installed in this build), ` +
        "so that part of the document was checked against the declared count rather than a run",
    );
  }
}

if (failures.length === 0) {
  console.log(`\nDesign doc matches the implementation. ${passed} assertions.`);
  process.exit(0);
}

console.error(`\n${failures.length} failure(s):`);
for (const failure of failures) console.error(`- ${failure}`);
process.exit(1);
