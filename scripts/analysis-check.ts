/**
 * Adapter checks for the analysis boundary, runnable without a browser.
 *
 * The workspace is built on this contract, so it is worth verifying on its own:
 * progressive discovery, abort keeping partial results, stripped binaries, a
 * class tree that has to be expanded, and a function count large enough to prove
 * the list is virtualised.
 *
 * Run with `npm run check:analysis`.
 */

import { createMockSource, unitsFor, readMockOptions } from "../src/lib/analysis/mock-source";
import { supports } from "../src/lib/analysis/types";
import { artifactAvailable } from "../src/lib/analysis/engine-artifacts";
import { Sha256 } from "../src/lib/sha256";
import { detectFormat, detectFormatFromBytes, type FormatMatch } from "../src/lib/detect-format";

declare const globalThis: { window?: unknown } & Record<string, unknown>;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label} -> ${JSON.stringify(actual)}`);
}
function checkThat(label: string, condition: boolean, detail: string): void {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label} ${detail}`);
}

function fakeFile(name: string, size: number): File {
  return { name, size } as File;
}
function setSearch(search: string): void {
  globalThis.window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    location: { search },
  };
}
function elfFormat(): FormatMatch {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  bytes.set([0xb7, 0x00], 18);
  return detectFormatFromBytes(bytes);
}
function apkFormat(): FormatMatch {
  const bytes = new Uint8Array(64);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  bytes.set([..."AndroidManifest.xml"].map((c) => c.charCodeAt(0)), 30);
  return detectFormatFromBytes(bytes);
}

const noDelay = "?mockDelay=0";

// 1. Symbol-rich ELF
setSearch(noDelay);
{
  const source = createMockSource(fakeFile("libtarget.so", 2 * 1024 * 1024), elfFormat());
  check("elf: unit count", source.units.length, 1);
  check("elf: unit engine", source.units[0]?.engine, "kuna");
  const unit = source.unit(source.primaryUnitId);
  const seen: number[] = [];
  const outcome = await unit.scan((state) => seen.push(state.discovered));
  check("elf: outcome", outcome, "ready");
  checkThat("elf: discovered roughly size/256", unit.functions().length === 8192, `got ${unit.functions().length}`);
  checkThat("elf: list grew over time", seen.length > 2 && seen[seen.length - 1]! > seen[0]!, `frames=${seen.length}`);
  const first = unit.functions()[0]!;
  const last = unit.functions()[unit.functions().length - 1]!;
  checkThat("elf: symbols come from the table", first.origin === "symbol" && /^[a-z_]+$/.test(first.name), `${first.name} / ${first.origin}`);
  checkThat("elf: remainder is discovered", last.origin === "discovered" && last.name.startsWith("FUN_"), `${last.name} / ${last.origin}`);
}

// 2. Stripped ELF
setSearch(`${noDelay}&mockSymbols=none`);
{
  const source = createMockSource(fakeFile("stripped.bin", 256 * 1024), elfFormat());
  const unit = source.unit(source.primaryUnitId);
  await unit.scan(() => {});
  check("stripped: symbol rows absent", unit.functions().every((f) => f.origin === "discovered"), true);
  checkThat("stripped: all names are FUN_", unit.functions().every((f) => f.name.startsWith("FUN_")), `n=${unit.functions().length}`);
}

// 3. Abort keeps partial results
setSearch("?mockDelay=0.4");
{
  const source = createMockSource(fakeFile("libtarget.so", 4 * 1024 * 1024), elfFormat());
  const unit = source.unit(source.primaryUnitId);
  const scan = unit.scan(() => {});
  await new Promise((r) => setTimeout(r, 260));
  unit.stop();
  const outcome = await scan;
  const kept = unit.functions().length;
  check("abort: outcome", outcome, "stopped");
  checkThat("abort: partial results kept", kept > 0 && kept < 16384, `kept ${kept} of 16384`);
}

// 4. Forced large count
setSearch(`${noDelay}&mockCount=120000`);
{
  const source = createMockSource(fakeFile("big.so", 1024), elfFormat());
  const unit = source.unit(source.primaryUnitId);
  await unit.scan(() => {});
  check("large: function count", unit.functions().length, 120000);
  check("large: navigator row count", unit.navigator().length, 120000);
}

// 5. APK units
setSearch(noDelay);
{
  const source = createMockSource(fakeFile("notes-release.apk", 18 * 1024 * 1024), apkFormat());
  checkThat("apk: has DEX plus native", source.units.length >= 2 && source.units[0]?.id === "dex", source.units.map((u) => u.id).join(","));
  check("apk: primary is DEX", source.primaryUnitId, "dex");
  checkThat("apk: native units carry .so labels", source.units.slice(1).every((u) => u.label.endsWith(".so")), source.units.slice(1).map((u) => u.label).join(","));
}

// 6. DEX tree expansion
{
  const source = createMockSource(fakeFile("notes-release.apk", 18 * 1024 * 1024), apkFormat());
  const dex = source.unit("dex");
  await dex.scan(() => {});
  const collapsed = dex.navigator();
  checkThat("dex: starts with package rows", collapsed.length > 0 && collapsed.every((n) => n.kind === "package"), `rows=${collapsed.length}`);
  const before = dex.revision();
  dex.toggle(collapsed[0]!.id);
  const expandedRows = dex.navigator();
  checkThat("dex: expansion adds class rows", expandedRows.some((n) => n.kind === "class"), `rows=${expandedRows.length}`);
  checkThat("dex: revision moved", dex.revision() > before, `${before} -> ${dex.revision()}`);
  const classRow = expandedRows.find((n) => n.kind === "class")!;
  dex.toggle(classRow.id);
  const withMethods = dex.navigator();
  checkThat("dex: second level adds method rows", withMethods.some((n) => n.kind === "method"), `rows=${withMethods.length}`);
}

// 7. 类：Java 的标签单位，所以契约必须知道一个类有哪些方法
{
  const source = createMockSource(fakeFile("notes-release.apk", 18 * 1024 * 1024), apkFormat());
  const dex = source.unit("dex");
  await dex.scan(() => {});

  const classes = dex.classes();
  checkThat("dex: there are classes", classes.length > 0, `${classes.length} classes`);

  const ids = new Set(dex.functions().map((f) => f.id));
  checkThat("dex: every member id is a real function", classes.every((c) => c.members.every((m) => ids.has(m))), "checked all");
  checkThat("dex: every class has members", classes.every((c) => c.members.length > 0), `min=${Math.min(...classes.map((c) => c.members.length))}`);
  checkThat("dex: a class is qualified, not just a name", classes.every((c) => c.qualifiedName.includes(".")), classes[0]?.qualifiedName ?? "none");
  checkThat("dex: member order is the source order", classes.every((c) => c.members.length === new Set(c.members).size), "no duplicates");
  // 包的**名字**会重复，所以 id 必须唯一 —— 撞了就会跳错类
  check("dex: every class id is unique", classes.length, new Set(classes.map((c) => c.id)).size);
  checkThat("dex: and every member belongs to exactly one class", (() => {
    const seen = new Map();
    for (const klass of classes) for (const member of klass.members) seen.set(member, (seen.get(member) ?? 0) + 1);
    return [...seen.values()].every((count) => count === 1);
  })(), "each member in one class");

  // 导航行要能说明自己代表哪个类、哪个方法，否则点击无处可去。
  // 类行只有在所属包展开后才出现，所以先展开一个。
  const packageRow = dex.navigator().find((r) => r.kind === "package");
  if (packageRow) dex.toggle(packageRow.id);
  const rows = dex.navigator();
  const classRow = rows.find((r) => r.kind === "class");
  checkThat("navigator: a class row carries its class id", Boolean(classRow?.classId), `${classRow?.classId}`);
  checkThat("navigator: a class row opens the class, not a function", classRow?.functionId === null, `${classRow?.functionId}`);

  // 方法行同样要等到类展开后才出现
  if (classRow) dex.toggle(classRow.id);
  const methodRow = dex.navigator().find((r) => r.kind === "method");
  checkThat("navigator: a method row carries both ids", Boolean(methodRow?.classId) && Boolean(methodRow?.functionId), `${methodRow?.classId} / ${methodRow?.functionId}`);

  // 导入导出在这个语言下是类型与公开 API，不是 libc 符号
  const imports = dex.imports();
  const exports_ = dex.exports();
  checkThat("dex: imports are types it references", imports.length > 0 && imports.every((i) => i.name.includes(".")), `${imports.length}`);
  checkThat("dex: exports are its public API", exports_.length > 0 && exports_.every((e) => e.module === "public"), `${exports_.length}`);

  const nativeUnit = source.units.find((u) => u.kind === "native");
  if (!nativeUnit) throw new Error("the APK mock produced no native unit");
  const native = source.unit(nativeUnit.id);

  /*
   * 原生单元的函数是渐进发现的，而字符串表的计数会被立刻读走（栏里要显示它）。
   * 如果建表时就把宿主写死，那一刻函数还一个都没有，于是所有原生字符串永远没有宿主，
   * 点击也就永远跳不动。所以宿主必须延迟绑定。
   */
  const early = native.strings();
  checkThat("native: the string count is readable before any function exists", early.length > 0, `${early.length} strings`);
  checkThat("native: and none of them claims an owner yet", early.every((entry) => entry.functionId === null), `${early.filter((entry) => entry.functionId !== null).length} already owned`);
  await native.scan(() => {});
  const late = native.strings();
  checkThat("native: after the scan every string has an owner", late.length === early.length && late.every((entry) => entry.functionId !== null), `${late.filter((entry) => entry.functionId === null).length} ownerless`);
  checkThat("native: and every owner is a real function", late.every((entry) => native.functions().some((fn) => fn.id === entry.functionId)), "owners resolve");
  checkThat("native: binding owners did not reshuffle the table", late.every((entry, index) => entry.address === early[index]?.address && entry.value === early[index]?.value), "addresses and values stable");
  await native.scan(() => {});
  check("native: there are no classes", native.classes().length, 0);
  checkThat(
    "native: its imports are library symbols, not types",
    native.imports().length > 0 && native.imports().every((i) => !i.name.includes(".")),
    `${native.imports().length}`,
  );
  checkThat(
    "native: its exports are JNI entry points",
    native.exports().length > 0 && native.exports().every((e) => e.module === "JNI"),
    `${native.exports().length}`,
  );
  checkThat(
    "the two units do not share a symbol table",
    native.imports()[0]?.name !== imports[0]?.name,
    `${imports[0]?.name} vs ${native.imports()[0]?.name}`,
  );
}

// 8. Strings point at real functions, and code decompiles
{
  const source = createMockSource(fakeFile("libtarget.so", 2 * 1024 * 1024), elfFormat());
  const unit = source.unit(source.primaryUnitId);
  await unit.scan(() => {});
  const strings = unit.strings();
  const ids = new Set(unit.functions().map((f) => f.id));
  checkThat("strings: non-empty", strings.length > 0, `n=${strings.length}`);
  checkThat("strings: every xref target exists", strings.every((s) => s.functionId === null || ids.has(s.functionId)), "checked all");
  const code = await unit.decompile(unit.functions()[0]!.id);
  checkThat("code: has lines with addresses", code.lines.length > 5 && code.lines.some((l) => l.address > 0), `lines=${code.lines.length}`);
  const asm = await unit.disassemble(unit.functions()[0]!.id);
  checkThat("asm: has bytes and text", asm.lines.length > 0 && asm.lines[0]!.bytes.length === 11, `lines=${asm.lines.length}`);
  const sections = unit.sections();
  const imports = unit.imports();
  const exports_ = unit.exports();
  checkThat("meta: sections and imports present", sections.length > 4 && imports.length > 0, `sections=${sections.length} imports=${imports.length}`);
  checkThat("meta: exports are a separate list", exports_.length > 0 && !exports_.some((e) => imports.some((i) => i.name === e.name)), `imports=${imports.length} exports=${exports_.length}`);
}

// 8. Options parsing
check("options: stripped from param", readMockOptions("?mockSymbols=none", "a.bin").stripped, true);
check("options: stripped from file name", readMockOptions("", "target-stripped.bin").stripped, true);
check("options: delay default", readMockOptions("", "a.bin").delayScale, 1);
check("options: count ignored when absent", readMockOptions("", "a.bin").functionCount, null);

// 9. Capabilities
//
// 空集合和"答不上来"在外面看是一样的，而它们不是一回事：前者是"这个二进制没有"，
// 后者是"这个引擎不知道"。UI 靠 capabilities 区分，所以它必须诚实 —— 任何取到了
// 内容的集合，都必须声明了对应的能力，否则界面会把它藏起来。
{
  const source = createMockSource(fakeFile("notes-release.apk", 18 * 1024 * 1024), apkFormat());
  const all = source.units.map((u) => source.unit(u.id));

  const mapping: readonly [string, (unit: (typeof all)[number]) => number][] = [
    ["strings", (unit) => unit.strings().length],
    ["sections", (unit) => unit.sections().length],
    ["imports", (unit) => unit.imports().length],
    ["exports", (unit) => unit.exports().length],
    ["classes", (unit) => unit.classes().length],
  ];

  const overclaimed = all.flatMap((unit) =>
    mapping
      .filter(([capability, size]) => size(unit) > 0 && !supports(unit, capability as never))
      .map(([capability]) => `${unit.unit.id}:${capability}`),
  );
  checkThat("capabilities: nothing is produced without being declared", overclaimed.length === 0, overclaimed.join(", "));

  const dex = all.find((unit) => unit.unit.kind === "dex");
  const native = all.find((unit) => unit.unit.kind === "native");
  checkThat("capabilities: the dex unit declares classes", dex !== undefined && supports(dex, "classes"), `${dex?.unit.id}`);
  checkThat("capabilities: the native unit does not", native !== undefined && !supports(native, "classes"), `${native?.unit.id}`);
  checkThat("capabilities: and it still declares strings", native !== undefined && supports(native, "strings"), `${native?.unit.id}`);

  // 每个单元都必须声明，空的声明会让界面退化成只剩下代码
  checkThat(
    "capabilities: every unit declares something",
    all.every((unit) => unit.capabilities.length > 0),
    all.map((unit) => `${unit.unit.id}:${unit.capabilities.length}`).join(" "),
  );
}

// 10. The engine-artifact probe
//
// 上线之后 Rasc 时好时坏：同一个页面加载，有时说"引擎没装"，有时正常。原因是探针把
// **否定的答案也缓存了** —— 页面加载时丢一次请求（站点 25 MB，CDN 冷启动），那个引擎
// 在整次会话里就一直是"没装"。所以只缓存"有"，"没有"要重新问。
{
  const url = "https://example.test/engine.wasm";

  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("network");
    return new Response(null, { status: 200, headers: { "content-length": "2000000" } });
  }) as unknown as typeof fetch;

  // 第一次真的失败，答"没有"
  checkThat("artifact probe: a dropped request answers no", (await artifactAvailable(url, 1_000_000, flaky)) === false, "no");
  // 但"没有"没有被记住，所以第二次问就拿到了
  checkThat("artifact probe: asking again finds it", (await artifactAvailable(url, 1_000_000, flaky)) === true, `after ${calls} call(s)`);
  check("artifact probe: and it took exactly two asks", calls, 2);

  // 存在之后就是事实，不必再问
  await artifactAvailable(url, 1_000_000, flaky);
  check("artifact probe: a positive answer is remembered", calls, 2);

  // 太小的一律当没有：静态站的 SPA fallback 对不存在的路径回 200 加 index.html
  const small = (async () => new Response(null, { status: 200, headers: { "content-length": "1200" } })) as unknown as typeof fetch;
  checkThat("artifact probe: a 200 that is not the artifact is refused", (await artifactAvailable("https://example.test/small.wasm", 1_000_000, small)) === false, "refused");

  const missing = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  checkThat("artifact probe: a 404 is refused", (await artifactAvailable("https://example.test/missing.wasm", 1_000_000, missing)) === false, "refused");
}

// 11. Unit derivation is stable for the same file
check("units: stable across calls", unitsFor(elfFormat(), "a.bin", 12345).length, unitsFor(elfFormat(), "a.bin", 12345).length);

// 12. SHA-256：readout 里的那一行不是猜的
{
  const enc = new TextEncoder();
  const digest = (text: string) => {
    const hash = new Sha256();
    hash.update(enc.encode(text));
    return hash.digest();
  };
  check("sha: empty", digest(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  check("sha: abc", digest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  check(
    "sha: the 448-bit case",
    digest("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );

  // 分块点不该改变结果：一个文件被切成两半读，就是这里最容易出错的地方。
  const message = new Uint8Array(200).map((_, index) => (index * 37 + 11) & 0xff);
  const splittable = (() => {
    const hash = new Sha256();
    hash.update(message);
    return hash.digest();
  })();
  let same = true;
  for (let split = 0; split <= message.length; split += 1) {
    const hash = new Sha256();
    hash.update(message.subarray(0, split));
    hash.update(message.subarray(split));
    if (hash.digest() !== splittable) same = false;
  }
  checkThat("sha: every split of the same bytes agrees", same, "200 split points");
}

// 14. 前缀不是格式：真正的 APK 的头 4KB 可能一个标记都没有
{
  /** A ZIP with the given central-directory names. Only detection reads it. */
  function zipOf(names: readonly string[], fillerBytes = 0): Uint8Array<ArrayBuffer> {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const directory: { name: Uint8Array; offset: number; size: number }[] = [];
    let offset = 0;

    for (const [index, name] of names.entries()) {
      const nameBytes = encoder.encode(name);
      const size = index === 0 ? fillerBytes : 0;
      const local = new Uint8Array(30 + nameBytes.length + size);
      new DataView(local.buffer).setUint32(0, 0x04034b50, true);
      new DataView(local.buffer).setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      chunks.push(local);
      directory.push({ name: nameBytes, offset, size });
      offset += local.length;
    }

    const centralStart = offset;
    for (const entry of directory) {
      const row = new Uint8Array(46 + entry.name.length);
      const view = new DataView(row.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint32(20, entry.size, true);
      view.setUint32(24, entry.size, true);
      view.setUint16(28, entry.name.length, true);
      view.setUint32(42, entry.offset, true);
      row.set(entry.name, 46);
      chunks.push(row);
      offset += row.length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, directory.length, true);
    endView.setUint16(10, directory.length, true);
    endView.setUint32(12, offset - centralStart, true);
    endView.setUint32(16, centralStart, true);
    chunks.push(end);

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out: Uint8Array<ArrayBuffer> = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  const late = zipOf(
    ["META-INF/com/android/build/gradle/app-metadata.properties", "AndroidManifest.xml", "classes.dex"],
    6000,
  );
  // 头 4KB 里只有第一个条目的本地头，标记在中央目录里
  check("detect: a prefix cannot tell an APK from an archive", detectFormatFromBytes(late.subarray(0, 4096)).id, "zip");
  check("detect: the file is an APK once its directory is read", (await detectFormat(new File([late], "late.apk"))).id, "apk");
  check(
    "detect: and a plain archive stays an archive",
    (await detectFormat(new File([zipOf(["docs/readme.txt"])], "toolchain.zip"))).id,
    "zip",
  );
}

if (failures > 0) {
  throw new Error(`${failures} adapter check(s) failed`);
}

console.log("\nall adapter checks passed");
