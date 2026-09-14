/**
 * Content pools and generators for the mock analysis source.
 *
 * This exists so the workspace can be built and judged before the real engines
 * are wired in. The output is plausible rather than accurate: it is shaped to
 * exercise the interface, especially the ugly cases — stripped binaries, deeply
 * nested class trees, and code that does not fit on one screen.
 */

import type { CodeLine, DisassemblyLine, SectionEntry, StringEntry, SymbolEntry } from "./types";
import type { Random } from "./random";

const NATIVE_SYMBOLS = [
  "auth_parse_token",
  "auth_check_expiry",
  "auth_store_session",
  "auth_clear_state",
  "session_open",
  "session_close",
  "token_decode",
  "token_verify_signature",
  "keystore_read",
  "keystore_write",
  "biometric_gate",
  "device_binding_hash",
  "audit_write",
  "clock_monotonic",
  "buffer_pool_get",
  "buffer_pool_put",
  "socket_connect",
  "socket_read_frame",
  "tls_handshake",
  "certificate_pin_check",
  "json_parse_object",
  "json_write_string",
  "base64_decode",
  "hmac_sha256",
  "pbkdf2_derive",
  "random_bytes",
  "mutex_lock",
  "mutex_unlock",
  "thread_pool_submit",
  "atomic_increment",
] as const;

const EXTERNAL_IMPORTS = [
  "malloc",
  "free",
  "memcpy",
  "memset",
  "strcmp",
  "strlen",
  "snprintf",
  "pthread_create",
  "pthread_join",
  "clock_gettime",
  "open",
  "read",
  "write",
  "close",
  "ioctl",
  "send",
  "recv",
  "getaddrinfo",
  "SSL_read",
  "SSL_write",
] as const;

const IMPORT_MODULES = ["libc.so", "libc++_shared.so", "libssl.so", "liblog.so", "libcrypto.so"] as const;

/** JNI entry points, which is what an Android library actually exports. */
const NATIVE_EXPORTS = [
  "JNI_OnLoad",
  "JNI_OnUnload",
  "Java_com_example_notes_auth_LoginActivity_authenticate",
  "Java_com_example_notes_auth_LoginActivity_refreshToken",
  "Java_com_example_notes_auth_TokenStore_read",
  "Java_com_example_notes_auth_TokenStore_write",
  "Java_com_example_notes_auth_SessionManager_restore",
  "Java_com_example_notes_auth_BiometricGate_isSatisfied",
] as const;

const DEX_TYPE_IMPORTS = [
  "android.content.Context",
  "android.os.Bundle",
  "android.view.View",
  "androidx.appcompat.app.AppCompatActivity",
  "okhttp3.OkHttpClient",
  "com.google.gson.Gson",
  "javax.crypto.Cipher",
  "java.security.KeyStore",
  "java.util.concurrent.ExecutorService",
  "android.util.Log",
] as const;

const DEX_API_EXPORTS = [
  "com.example.notes.api.NotesApi",
  "com.example.notes.api.Session",
  "com.example.notes.ui.NotesActivity",
  "com.example.notes.data.NoteRepository",
] as const;

const SECTION_TEMPLATE: readonly { name: string; flags: string; weight: number }[] = [
  { name: ".interp", flags: "A", weight: 1 },
  { name: ".note.android.ident", flags: "A", weight: 1 },
  { name: ".dynsym", flags: "A", weight: 3 },
  { name: ".dynstr", flags: "A", weight: 8 },
  { name: ".gnu.hash", flags: "A", weight: 2 },
  { name: ".rela.dyn", flags: "A", weight: 6 },
  { name: ".init_array", flags: "AW", weight: 1 },
  { name: ".text", flags: "AX", weight: 180 },
  { name: ".rodata", flags: "A", weight: 24 },
  { name: ".eh_frame_hdr", flags: "A", weight: 2 },
  { name: ".eh_frame", flags: "A", weight: 18 },
  { name: ".data.rel.ro", flags: "AW", weight: 9 },
  { name: ".dynamic", flags: "AW", weight: 1 },
  { name: ".got", flags: "AW", weight: 3 },
  { name: ".data", flags: "AW", weight: 4 },
  { name: ".bss", flags: "AW", weight: 6 },
];

const STRING_POOL = [
  "expired session",
  "GET /v1/auth",
  "POST /v1/session",
  "application/json",
  "Bearer ",
  "Authorization",
  "DESCRIPTION",
  "com.example.notes",
  "https://api.example.com",
  "text/html; charset=utf-8",
  "invalid signature",
  "device binding mismatch",
  "keystore unavailable",
  "biometric prompt cancelled",
  "session restored",
  "token refreshed",
  "%s/%s/%s",
  "utf-8",
  "AES/GCM/NoPadding",
  "android.intent.action.VIEW",
  "/proc/self/maps",
  "libc++_shared.so",
  "socket closed by peer",
  "handshake failed",
  "certificate pin mismatch",
  "retry budget exhausted",
  "content://com.example.notes.provider",
  "cache/",
  "notes.db",
];

const PACKAGE_STEMS = ["com.example.notes", "com.example.core", "com.example.net", "org.example.crypto"] as const;
const PACKAGE_LEAVES = ["auth", "data", "ui", "sync", "model", "util", "net", "cache"] as const;

const CLASS_STEMS = [
  "LoginActivity",
  "TokenStore",
  "SessionManager",
  "BiometricGate",
  "AuthInterceptor",
  "DeviceBinding",
  "NoteRepository",
  "SyncWorker",
  "CacheIndex",
  "PayloadCodec",
  "HeaderParser",
  "RetryPolicy",
] as const;

const METHOD_STEMS = [
  "authenticate",
  "refresh",
  "store",
  "read",
  "clear",
  "decode",
  "encode",
  "verify",
  "onCreate",
  "onDestroy",
  "run",
  "apply",
  "bind",
  "release",
] as const;

const C_TYPES = ["uint64_t", "int32_t", "size_t", "void *", "char *", "bool"] as const;

const AARCH64_OPS = [
  "stp x29, x30, [sp, #-0x20]!",
  "mov x29, sp",
  "str w0, [sp, #0x1c]",
  "ldr w8, [sp, #0x1c]",
  "cbz w8, {target}",
  "cbnz x0, {target}",
  "bl {callee}",
  "mov x0, xzr",
  "mov w0, #0x1",
  "add x8, x8, #0x10",
  "ldr x8, [x8]",
  "cmp w0, #0x0",
  "b.eq {target}",
  "b.ne {target}",
  "mov x1, x0",
  "adrp x8, {page}",
  "ret",
  "nop",
] as const;

export interface GeneratedFunction {
  readonly name: string;
  readonly address: number;
  readonly size: number;
}

export function nativeSymbolPool(): readonly string[] {
  return NATIVE_SYMBOLS;
}

export function generateCode(
  random: Random,
  functionName: string,
  address: number,
  callables: readonly string[],
): readonly CodeLine[] {
  const lines: string[] = [];
  const lines_: CodeLine[] = [];
  const callee = (): string => {
    const name = callables[random.int(0, Math.max(0, callables.length - 1))];
    return name === undefined ? "helper" : name;
  };
  const argument = (): string => `${random.pick(C_TYPES)} arg${random.int(1, 3)}`;
  const string = (): string => random.pick(STRING_POOL);

  lines.push(`${random.pick(["bool", "int32_t", "void *", "uint64_t"])} ${functionName}(${argument()}) {`);
  lines.push(`  ${random.pick(C_TYPES)} local${random.int(1, 9)};`);
  lines.push(`  ${random.pick(C_TYPES)} state;`);
  lines.push("");

  const blocks = random.int(2, 4);
  for (let block = 0; block < blocks; block += 1) {
    switch (random.int(0, 3)) {
      case 0:
        lines.push(`  if (state == NULL) {`);
        lines.push(`    return ${random.pick(["false", "0", "NULL"])};`);
        lines.push("  }");
        break;
      case 1:
        lines.push(`  result = ${callee()}(state);`);
        lines.push("  if (result != 0) {");
        lines.push(`    log_write("${string()}");`);
        lines.push("    return result;");
        lines.push("  }");
        break;
      case 2:
        lines.push(`  state->field${random.int(1, 9)} = ${callee()}();`);
        lines.push(`  if (state->field${random.int(1, 9)} < now) {`);
        lines.push(`    audit_write("${string()}");`);
        lines.push("    return 0;");
        lines.push("  }");
        break;
      default:
        lines.push(`  /* ${string()} */`);
        lines.push(`  ${callee()}(state, ${random.int(1, 64)});`);
        break;
    }
    lines.push("");
  }

  lines.push(`  return ${random.pick(["true", "0", "state"])};`);
  lines.push("}");

  // Blank lines and comments do not advance the address counter, the way a
  // debugger's line mapping behaves.
  let cursor = address;
  for (const text of lines) {
    const advances = text.trim().length > 0 && !text.trim().startsWith("/*");
    lines_.push({ address: advances ? cursor : 0, text });
    if (advances) cursor += random.pick([4, 4, 4, 8]);
  }

  return lines_;
}

export function generateDisassembly(
  random: Random,
  address: number,
  size: number,
  callables: readonly string[],
): readonly DisassemblyLine[] {
  const lines: DisassemblyLine[] = [];
  const count = Math.max(4, Math.min(64, Math.round(size / 4)));
  let cursor = address;

  for (let index = 0; index < count; index += 1) {
    const template = random.pick(AARCH64_OPS);
    const text = template
      .replace("{target}", `0x${(address + random.int(1, count) * 4).toString(16)}`)
      .replace("{callee}", random.pick(callables))
      .replace("{page}", `0x${(address & 0xfffff000).toString(16)}`);
    const bytes = Array.from({ length: 4 }, () => random.int(0, 255).toString(16).padStart(2, "0")).join(" ");
    lines.push({ address: cursor, bytes, text });
    cursor += 4;
  }

  return lines;
}

/**
 * The string table before owners are bound.
 *
 * A string's owner cannot be decided when the table is generated: on a native
 * unit the functions are discovered progressively, and the navigator asks for the
 * string count as soon as the column renders, which is before the scan has
 * produced anything. Writing an owner then would freeze every native string as
 * ownerless for the session. So a stable slot is generated instead, and the owner
 * is resolved against whatever functions exist at read time.
 */
export type CachedString = Omit<StringEntry, "functionId"> & { readonly ownerSlot: number };

export function generateStrings(random: Random, count: number): readonly CachedString[] {
  const entries: CachedString[] = [];
  // A running cursor, because strings in a real binary are laid out in address
  // order and a table that is not sorted reads as broken to anyone who has used
  // one of these tools.
  let cursor = 0x104000;

  for (let index = 0; index < count; index += 1) {
    cursor += random.int(8, 48);
    const value = random.chance(0.25)
      ? `${random.pick(STRING_POOL)}/${index.toString(16)}`
      : random.pick(STRING_POOL);

    entries.push({
      id: `str:${index.toString(16)}`,
      address: cursor,
      value,
      xrefs: random.chance(0.6) ? 0 : random.int(1, 12),
      ownerSlot: random.int(0, 4095),
    });
  }

  return entries;
}

export function generateSections(random: Random, totalSize: number): readonly SectionEntry[] {
  const sections: SectionEntry[] = [];
  let cursor = 0x1000;

  for (const template of SECTION_TEMPLATE) {
    const size = Math.max(16, Math.round((totalSize / 512) * template.weight * (0.6 + random.next())));
    sections.push({
      name: template.name,
      address: cursor,
      size,
      flags: template.flags,
    });
    cursor += Math.round(size / 16) * 16;
  }

  return sections;
}

/** Symbols a native library takes from elsewhere. */
export function generateImports(random: Random, count: number): readonly SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const external = random.pick(EXTERNAL_IMPORTS);
    entries.push({
      name: index < EXTERNAL_IMPORTS.length ? external : `${external}@${index}`,
      module: random.pick(IMPORT_MODULES),
    });
  }
  return entries;
}

/** Symbols a native library offers: the JNI entry points its Java side calls. */
export function generateExports(_random: Random, count: number): readonly SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = NATIVE_EXPORTS[index % NATIVE_EXPORTS.length] ?? "JNI_OnLoad";
    entries.push({ name: index < NATIVE_EXPORTS.length ? name : `${name}_${index}`, module: "JNI" });
  }
  return entries;
}

/** Types a DEX refers to but does not define. */
export function generateDexImports(random: Random, count: number): readonly SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = random.pick(DEX_TYPE_IMPORTS);
    const framework = name.startsWith("android") || name.startsWith("java") || name.startsWith("javax");
    entries.push({
      name: index < DEX_TYPE_IMPORTS.length ? name : `${name}$${index}`,
      module: framework ? "framework" : "bundled",
    });
  }
  return entries;
}

/** What a DEX offers to anything linking it: its public API surface. */
export function generateDexExports(_random: Random, count: number): readonly SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = DEX_API_EXPORTS[index % DEX_API_EXPORTS.length] ?? "com.example.notes.api.NotesApi";
    entries.push({ name: index < DEX_API_EXPORTS.length ? name : `${name}V${index}`, module: "public" });
  }
  return entries;
}

export function packageNames(random: Random, count: number): readonly string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    names.push(`${random.pick(PACKAGE_STEMS)}.${random.pick(PACKAGE_LEAVES)}`);
  }
  return names;
}

export function className(random: Random): string {
  return `${random.pick(CLASS_STEMS)}${random.chance(0.3) ? random.int(2, 9) : ""}`;
}

export function methodName(random: Random): string {
  return `${random.pick(METHOD_STEMS)}${random.chance(0.4) ? random.pick(["Async", "Internal", "Locked", "Cached"]) : ""}`;
}

export function strippedName(address: number): string {
  return `FUN_${address.toString(16).padStart(8, "0")}`;
}

/** Stands in for a real digest. 64 hex characters, the length of a SHA-256. */
export function pseudoHash(random: Random): string {
  return Array.from({ length: 64 }, () => random.int(0, 15).toString(16)).join("");
}
