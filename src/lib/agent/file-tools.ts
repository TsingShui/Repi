/**
 * The shared filesystem, as tools.
 *
 * These are the three operations a person has on a file — look at it, make one, change one line
 * of it — and they exist because the agent could do none of them. A program's output went into
 * the conversation and stayed there; a script the agent wrote had to be written again every time
 * it was used; a log pulled off a phone was a name with no way to open it.
 *
 * What they are not is a second way to read binaries. `read` takes text and says so when it is
 * not, and it hands the caller a *window* rather than a file: the point of a tool result is that
 * it fits in a conversation, and the point of a file is that it does not have to.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  editText,
  looksBinary,
  normalizeVfsPath,
  readTextWindow,
  TEXT_READ_LIMIT,
  TEXT_WRITE_LIMIT,
} from "./text-files";

/** A tool result is text; this is the one place that turns a value into it, bounded. */
function toolText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const limit = 80_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[tool result truncated]`;
}

/** What these tools need: the shared filesystem, and somewhere to put what they write. */
export interface FileToolContext {
  readonly files: {
    /** Size in bytes, without reading them. Null when there is no such file. */
    stat(path: string): Promise<number | null>;
    read(path: string): Promise<Uint8Array | null>;
    write(path: string, bytes: Uint8Array, conversationId: string): Promise<void>;
  };
}

const READ_DESCRIPTION = `Read a text file from the shared filesystem, a window at a time.

This is where an agent's own work becomes readable: a script it wrote, a listing it produced, a
log it pulled off a device. What comes back is numbered by line and says how much of the file it
is: read lines 1-2000, then ask for 2001 onwards if the answer is in there.

  read('scripts/hook.js')
  read('notes/rasc-classes.txt', 120, 40)      // lines 120-159
  read('device/sdcard/logcat.txt', 5000)       // from line 5000

Files over ${TEXT_READ_LIMIT / (1 << 20)} MB are refused; those are binaries or logs that want
a program, not a window. A binary is refused too, with the engine to use instead.`;

const WRITE_DESCRIPTION = `Write a text file into the shared filesystem, where it stays.

This is the agent's scratch space and its output shelf at once. A file written here is visible in
the app's storage panel, readable by later conversations, mentionable by the user with \`@\`, and
copyable to a device with device_push — because it is a real file with a real path, not a note in
the conversation.

  write('scripts/hook.js', 'Java.perform(() => { … })')
  write('notes/findings.md', '# What the manifest showed\\n…')
  write('out/classes.txt', listing)

Writing a path that exists replaces it: this is the same namespace the engines write to, so a
path an engine produced is a path this can be asked to extend. Text only, up to ${TEXT_WRITE_LIMIT / 1024} KB
per call; binaries are the engines' business — they know where bytes come from.`;

const EDIT_DESCRIPTION = `Replace one exact string in a file, without rewriting the whole thing.

Editing by writing the file again means sending it again — a 300-line script costs 300 lines of
context to change one line. This changes one line.

  edit('scripts/hook.js', 'RETRY = 3', 'RETRY = 5')

The string must occur exactly once. If it is not in the file the file is not what you think it is,
and if it occurs twice the edit would be a guess; both are refused before anything is written, and
the refusal says which one happened. Read the file first, then quote enough of it to identify one
place.`;

export function fileTools(context: FileToolContext, conversationId: string): AgentTool[] {
  /** The file's bytes, or a refusal that names the reason. */
  const open = async (path: string): Promise<{ path: string; bytes: Uint8Array }> => {
    const size = await context.files.stat(path);
    if (size === null) {
      throw new Error(`There is no file at ${path}. The filesystem is shared between conversations and shown in the storage panel; ask what is there, or write one.`);
    }
    if (size > TEXT_READ_LIMIT) {
      throw new Error(
        `${path} is ${(size / (1 << 20)).toFixed(1)} MB. Reading tools are for text up to ` +
          `${TEXT_READ_LIMIT / (1 << 20)} MB — for something this size, use run_js with the engines, ` +
          "which read archives and binaries streaming.",
      );
    }
    const bytes = await context.files.read(path);
    if (bytes === null) throw new Error(`${path} could not be read.`);
    return { path, bytes };
  };

  return [
    {
      name: "read",
      label: "Read a file",
      description: READ_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: "Path in the shared filesystem, e.g. scripts/hook.js" }),
        offset: Type.Optional(Type.Number({ description: "First line to read, 1-based" })),
        limit: Type.Optional(Type.Number({ description: "How many lines" })),
      }),
      async execute(_toolCallId, input) {
        const params = input as { path: string; offset?: number; limit?: number };
        const path = normalizeVfsPath(params.path);
        const { bytes } = await open(path);
        if (looksBinary(bytes)) {
          throw new Error(
            `${path} is not text (${bytes.length} bytes). If it is a binary or an archive, run_js ` +
              "can open it with rasc or Kuna; a pulled APK or .so is exactly that case.",
          );
        }
        const window = readTextWindow(bytes, {
          ...(params.offset === undefined ? {} : { offset: params.offset }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        });
        const header =
          window.startLine === 0
            ? `${path} has ${window.totalLines ?? "?"} lines; there is nothing at line ${params.offset ?? 1}.`
            : `${path} — lines ${window.startLine}-${window.endLine}${
                window.totalLines === null ? "" : ` of ${window.totalLines}`
              }${window.truncated ? " (cut at the output ceiling)" : ""}, ${bytes.length} bytes`;
        return {
          content: [{ type: "text", text: toolText(`${header}\n\n${window.text}`) }],
          details: { path, ...window },
        };
      },
    },
    {
      name: "write",
      label: "Write a file",
      description: WRITE_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: "Path to write, e.g. scripts/hook.js" }),
        text: Type.String({ description: "The text to write" }),
      }),
      async execute(_toolCallId, input) {
        const params = input as { path: string; text: string };
        const path = normalizeVfsPath(params.path);
        if (path === "") throw new Error("write(path, text) needs a path.");
        const bytes = new TextEncoder().encode(params.text);
        if (bytes.length > TEXT_WRITE_LIMIT) {
          throw new Error(
            `${bytes.length} bytes is over the ${TEXT_WRITE_LIMIT} bytes a single write carries. ` +
              "Write it in parts under the same path, or have a program produce it.",
          );
        }
        const before = await context.files.stat(path);
        await context.files.write(path, bytes, conversationId);
        return {
          content: [
            {
              type: "text",
              text: toolText(
                before === null
                  ? `${path} written (${bytes.length} bytes).`
                  : `${path} replaced (${before} bytes before, ${bytes.length} now).`,
              ),
            },
          ],
          details: { path, bytes: bytes.length, replaced: before },
        };
      },
    },
    {
      name: "edit",
      label: "Edit a file",
      description: EDIT_DESCRIPTION,
      parameters: Type.Object({
        path: Type.String({ description: "Path in the shared filesystem" }),
        old: Type.String({ description: "The exact text to replace; it must occur exactly once" }),
        new: Type.String({ description: "What to replace it with; empty deletes it" }),
      }),
      async execute(_toolCallId, input) {
        const params = input as { path: string; old: string; new: string };
        const path = normalizeVfsPath(params.path);
        const { bytes } = await open(path);
        if (looksBinary(bytes)) throw new Error(`${path} is not text.`);
        const result = editText(new TextDecoder().decode(bytes), params.old, params.new);
        const written = new TextEncoder().encode(result.text);
        if (written.length > TEXT_WRITE_LIMIT) {
          throw new Error(`The edited file would be ${(written.length / 1024).toFixed(0)} KB, over the limit.`);
        }
        await context.files.write(path, written, conversationId);
        return {
          content: [
            {
              type: "text",
              text: toolText(
                `${path}: line ${result.line}, -${result.removed} +${result.added} characters.`,
              ),
            },
          ],
          details: { path, ...result },
        };
      },
    },
  ];
}
