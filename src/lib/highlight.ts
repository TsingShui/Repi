/**
 * A small syntax highlighter.
 *
 * The code view is read-only and shows one function at a time, so a full editor
 * framework would cost far more than it returns. This tokenises a single line
 * and the view renders the tokens as elements, which keeps the output out of
 * `innerHTML`.
 *
 * Known limit: a block comment spanning several lines is only recognised within
 * one line. The engines emit single-line comments, and the alternative is
 * carrying lexer state across lines for no visible gain.
 */

export type TokenKind = "plain" | "keyword" | "type" | "function" | "string" | "comment" | "number" | "register";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const C_PATTERN = new RegExp(
  [
    "(/\\*[\\s\\S]*?\\*/|//[^\\n]*)", // comment
    "(\"(?:\\\\.|[^\"\\\\])*\")", // string
    "\\b(if|else|for|while|do|return|break|continue|switch|case|default|goto|sizeof|struct|union|enum|typedef|static|const|volatile|extern|register|inline|NULL)\\b", // keyword
    "\\b(void|bool|_Bool|char|short|int|long|float|double|unsigned|signed|size_t|ssize_t|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t|undefined\\d*|byte|word|dword|qword)\\b", // type
    "\\b([A-Za-z_]\\w*)(?=\\s*\\()", // function
    "\\b(0x[0-9a-fA-F]+|\\d+)\\b", // number
  ].join("|"),
  "g",
);

const ASM_PATTERN = new RegExp(
  [
    "(;.*$)", // comment
    "^(\\s*)([a-z][a-z0-9.]*)", // mnemonic at line start
    "\\b(x\\d{1,2}|w\\d{1,2}|sp|wsp|lr|xzr|wzr|pc)\\b", // register
    "(#?0x[0-9a-fA-F]+)", // immediate or address
    "\\b([a-z][a-z0-9.]*)(?=\\s)", // operand
  ].join("|"),
  "g",
);

/**
 * Java, as the decompiler prints it.
 *
 * Two differences from the C pattern are worth naming. A call site is matched with
 * its receiver — `Foo.bar` is one token — because the receiver is the only thing
 * that says which class `bar` belongs to, and a bare method name is ambiguous
 * across a whole archive. And a capitalised identifier is painted as a type,
 * which is how the decompiler prints every class name, so the code reads the way
 * Java is normally written.
 *
 * The call alternative must come before the type one, or `Foo.bar(` would be a
 * type followed by a bare call and the receiver would be lost.
 */
const JAVA_PATTERN = new RegExp(
  [
    "(/\\*[\\s\\S]*?\\*/|//[^\\n]*)", // comment
    "(\"(?:\\\\.|[^\"\\\\])*\")", // string
    "('(?:\\\\.|[^'\\\\])')", // character literal
    "(@[A-Za-z_$][\\w$]*)", // annotation
    "\\b(abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|volatile|while|true|false|null)\\b", // keyword
    "\\b((?:[A-Za-z_$][\\w$]*\\.)*[A-Za-z_$][\\w$]*)(?=\\s*\\()", // call, with its receiver
    "\\b(boolean|byte|char|double|float|int|long|short|void)\\b", // primitive type
    "\\b([A-Z][a-z0-9_$][A-Za-z0-9_$]*)\\b", // class name
    "\\b(0x[0-9a-fA-F]+|\\d+)\\b", // number
  ].join("|"),
  "g",
);

function tokenise(line: string, pattern: RegExp, assign: (groups: (string | undefined)[]) => TokenKind): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  pattern.lastIndex = 0;
  let match = pattern.exec(line);
  while (match !== null) {
    if (match.index > cursor) {
      const gap = line.slice(cursor, match.index);
      if (gap.length > 0) tokens.push({ kind: "plain", text: gap });
    }

    const text = match[0];
    const groups: (string | undefined)[] = match.slice(1);
    tokens.push({ kind: assign(groups), text });
    cursor = match.index + text.length;
    match = pattern.exec(line);

    if (text.length === 0) pattern.lastIndex += 1;
  }

  if (cursor < line.length) tokens.push({ kind: "plain", text: line.slice(cursor) });
  return tokens;
}

export function highlightC(line: string): Token[] {
  return tokenise(line, C_PATTERN, (groups) => {
    if (groups[0] !== undefined) return "comment";
    if (groups[1] !== undefined) return "string";
    if (groups[2] !== undefined) return "keyword";
    if (groups[3] !== undefined) return "type";
    if (groups[4] !== undefined) return "function";
    if (groups[5] !== undefined) return "number";
    return "plain";
  });
}

export function highlightAsm(line: string): Token[] {
  return tokenise(line, ASM_PATTERN, (groups) => {
    if (groups[0] !== undefined) return "comment";
    if (groups[2] !== undefined) return "function";
    if (groups[3] !== undefined) return "register";
    if (groups[4] !== undefined) return "number";
    if (groups[5] !== undefined) return "plain";
    return "plain";
  });
}

export function highlightJava(line: string): Token[] {
  return tokenise(line, JAVA_PATTERN, (groups) => {
    if (groups[0] !== undefined) return "comment";
    if (groups[1] !== undefined || groups[2] !== undefined) return "string";
    if (groups[3] !== undefined || groups[4] !== undefined) return "keyword";
    if (groups[5] !== undefined) return "function";
    if (groups[6] !== undefined || groups[7] !== undefined) return "type";
    if (groups[8] !== undefined) return "number";
    return "plain";
  });
}
