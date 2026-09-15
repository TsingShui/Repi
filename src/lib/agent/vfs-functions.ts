/**
 * Files, as a program sees them.
 *
 * The sandbox already held two maps — what earlier sessions produced, and what this session has
 * written — and only the engines could touch them: rasc opened a file because the WASI host
 * mounted it, and Kuna opened one the same way. A program could list the files and not read a
 * byte of them, which made the shared filesystem something a program could point at but not use.
 *
 * Two functions fix that, and they are deliberately the same two the agent's tools offer: a
 * program reads the file it produced, and produces the file the agent later reads. Writing here
 * is how anything a program computes survives the run at all — the maps go back to the host as
 * the program's output, and the host keeps them.
 */
import {
  editText,
  looksBinary,
  normalizeVfsPath,
  readTextWindow,
  TEXT_READ_LIMIT,
  TEXT_WRITE_LIMIT,
} from "./text-files";

/** The bytes a program may reach: what this session wrote, and what every session can read. */
export interface VfsMaps {
  readonly written: Map<string, Uint8Array>;
  readonly shared: Map<string, Uint8Array>;
}

function find(maps: VfsMaps, path: string): Uint8Array {
  // The writable side wins a collision, which is the same rule the mount and `ls()` use: a file
  // this session rewrote is this session's file.
  const bytes = maps.written.get(path) ?? maps.shared.get(path);
  if (bytes === undefined) {
    throw new Error(`${path} is not in the sandbox. Call ls() to see what is.`);
  }
  return bytes;
}

/**
 * The sandbox's file functions, bound to one session's maps.
 *
 * Kept apart from the Worker that uses them because a Worker is a bad place to keep logic: these
 * are pure reads and writes over two maps, and they can be checked without one.
 */
export function createVfsFunctions(maps: VfsMaps): {
  read(args: readonly unknown[]): string;
  write(args: readonly unknown[]): { path: string; bytes: number };
  edit(args: readonly unknown[]): { path: string; line: number; removed: number; added: number };
} {
  return {
    /**
     * Text from a file, by line.
     *
     * Only files this sandbox holds, which is every file in the shared filesystem: they are
     * mounted for the engines anyway, so reading one costs nothing extra.
     */
    read(args: readonly unknown[]): string {
      const path = normalizeVfsPath(String(args[0] ?? ""));
      if (path === "") throw new Error("read(path) needs a file name; ls() says what is here.");
      const bytes = find(maps, path);
      if (bytes.length > TEXT_READ_LIMIT && args[1] === undefined) {
        throw new Error(
          `${path} is ${(bytes.length / (1 << 20)).toFixed(1)} MB. Pass a line offset and a limit ` +
            "to read a window of it instead of the whole thing.",
        );
      }
      if (looksBinary(bytes)) {
        throw new Error(`${path} is not text. Use rasc() or kuna() to read it.`);
      }
      const window = readTextWindow(bytes, {
        ...(args[1] === undefined ? {} : { offset: Number(args[1]) }),
        ...(args[2] === undefined ? {} : { limit: Number(args[2]) }),
      });
      // The text itself, with no header: this is data a program will split and parse, and a line
      // saying "showing 120-160" would be the first thing it parsed wrong. The tool of the same
      // name adds that header for the model, which is the reader it is written for.
      return window.text;
    },

    /**
     * Text into a file, which the host keeps under that path.
     *
     * The path is a name in the shared filesystem, not a directory operation: an engine that
     * produced a file keeps it, and a program that rewrites one replaces it.
     */
    write(args: readonly unknown[]): { path: string; bytes: number } {
      const path = normalizeVfsPath(String(args[0] ?? ""));
      if (path === "") throw new Error("write(path, text) needs a file name.");
      const text = String(args[1] ?? "");
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > TEXT_WRITE_LIMIT) {
        throw new Error(
          `${bytes.length} bytes of text is over the limit of ${TEXT_WRITE_LIMIT} bytes per write. ` +
            "Write it in parts under the same path, or let an engine produce it.",
        );
      }
      maps.written.set(path, bytes);
      return { path, bytes: bytes.length };
    },

    /**
     * One exact string replaced, in the file that already exists.
     *
     * The same rule as the tool of the same name: the string must occur exactly once. A program
     * could do this with `read` and `write` in two lines, and the reason this exists anyway is
     * that the two lines are where a guess gets written to a file.
     */
    edit(args: readonly unknown[]): { path: string; line: number; removed: number; added: number } {
      const path = normalizeVfsPath(String(args[0] ?? ""));
      if (path === "") throw new Error("edit(path, old, new) needs a file name.");
      const bytes = find(maps, path);
      if (looksBinary(bytes)) throw new Error(`${path} is not text.`);
      const text = new TextDecoder().decode(bytes);
      const result = editText(text, String(args[1] ?? ""), String(args[2] ?? ""));
      const written = new TextEncoder().encode(result.text);
      if (written.length > TEXT_WRITE_LIMIT) {
        throw new Error(`The edited file would be ${(written.length / 1024).toFixed(0)} KB, over the limit.`);
      }
      maps.written.set(path, written);
      return { path, line: result.line, removed: result.removed, added: result.added };
    },
  };
}
