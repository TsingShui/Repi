/**
 * Rasc's WASI host, for the Worker.
 *
 * Rasc is a `wasm32-wasip1` program: it takes a command line, an environment and a
 * directory it is allowed to read, and it writes stdout, stderr and an exit code. This file
 * is the host side of that — the virtual filesystem the user's `File` is mounted in, the two
 * output streams, and one run per call.
 *
 * Two properties are worth stating, because they are what the arrangement buys:
 *
 *  - **The archive is never copied.** The mount is a read-only inode that serves byte ranges
 *    from the `Blob` on demand, through a read-ahead window. The parser asks for tens of
 *    thousands of small ranges and each one would otherwise be a synchronous trip to the file
 *    backend (~190 µs measured, which is 18 s for one command).
 *  - **The interpreter is the process.** Nothing here knows how a command is spelled or what
 *    it prints; `argv` goes in and bytes come out. Adding an engine capability is a change in
 *    Rust, not in TypeScript.
 *
 * One run per instance: WASI cannot be interrupted from outside, so cancelling is
 * `Worker.terminate()` in the driver and the instance goes with it.
 */
import {
  Directory,
  Fd,
  File,
  Inode,
  OpenFile,
  PreopenDirectory,
  WASI,
  wasi,
} from "../../../vendor/kuna/vendor/browser_wasi_shim/dist/index.js";
import type { FilestatShape } from "../../../vendor/kuna/vendor/browser_wasi_shim/dist/index.js";

/** Where the user's file is mounted, and the only path a command line should name. */
export const MOUNT = "/work";
export const ARCHIVE_PATH = `${MOUNT}/archive.apk`;

/**
 * Builds a directory tree from slash-separated paths.
 *
 * A host mounts what a program expects to find: rasc gets one archive at a known path, Kuna
 * gets its binary plus the SLEIGH spec tree it resolves languages in. Both are trees of names
 * to bytes, so both are built here.
 */
export function treeFromPaths(
  entries: Iterable<readonly [string, Uint8Array | Blob]>,
  options: { readOnly?: boolean } = {},
): MountedTree {
  const root = new Map<string, Inode>();
  const readers: BlobReader[] = [];
  const files = new Map<string, File>();
  for (const [path, value] of entries) {
    const parts = path.split("/").filter((part) => part.length > 0);
    const name = parts.pop();
    if (name === undefined) continue;
    let at = root;
    for (const part of parts) {
      let next = at.get(part);
      if (!(next instanceof Directory)) {
        next = new Directory(new Map());
        at.set(part, next);
      }
      at = (next as Directory).contents;
    }
    if (value instanceof Uint8Array) {
      const file = new File(value, options.readOnly ? { readonly: true } : undefined);
      files.set(name, file);
      at.set(name, file);
    } else {
      const file = new BlobFile(value);
      readers.push(file.reader);
      // `BlobFile` is read-only by construction: an attachment is the user's file, and an
      // engine that could write to it would be writing through to nothing.
      at.set(name, file);
    }
  }
  return { tree: root, readers, files };
}

/** A mounted tree, the windowed readers behind it, and its leaf files. */
export interface MountedTree {
  readonly tree: Map<string, Inode>;
  readonly readers: readonly BlobReader[];
  /**
   * The bytes-backed leaves, by name.
   *
   * A host keeps this to answer two questions after a run: what did the program write, and
   * what is in the sandbox at all. `Blob`-backed mounts are absent on purpose — they are the
   * user's files, not something a program produced.
   */
  readonly files: Map<string, File>;
}

/** One mounted directory: the guest path a program is told about, and its contents. */
export interface WasiMount {
  readonly path: string;
  readonly tree: Map<string, Inode>;
}

/** Anything that can be a WASI program: argv, an environment, mounts, two streams. */
export interface WasiProgram {
  readonly wasm: WebAssembly.Module;
  /** `argv[0]`: the name the program calls itself. */
  readonly name: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly mounts?: readonly WasiMount[];
}

/**
 * Runs one program to completion, synchronously.
 *
 * Nothing here knows which program it is. rasc and Kuna are both `wasm32-wasip1` builds, so
 * the difference between them is the argument list and what is mounted — which is the whole
 * reason a host can carry two engines in one mechanism.
 */
export function runProgramSync(program: WasiProgram): WasiProgramResult {
  const stdout = new ByteStream();
  const stderr = new ByteStream();
  const fds: Fd[] = [
    new OpenFile(new File(new Uint8Array(0))), // stdin: neither engine reads it
    stdout,
    stderr,
    ...(program.mounts ?? []).map((mount) => new PreopenDirectory(mount.path, mount.tree)),
  ];

  const env = Object.entries(program.env ?? {}).map(([name, value]) => `${name}=${value}`);
  const wasi = new WASI([program.name, ...program.args], env, fds, { debug: false });
  const instance = new WebAssembly.Instance(program.wasm, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const code = wasi.start(instance);
  const memory = instance.exports.memory as WebAssembly.Memory | undefined;

  return {
    code,
    stdout: stdout.take(),
    stderr: stderr.take(),
    memoryBytes: memory?.buffer.byteLength ?? 0,
  };
}

/** Read-ahead window. One backend call per window instead of one per range. */
const WINDOW = 4 << 20;

/** Collects a stream's bytes as they are written. */
class ByteStream extends Fd {
  readonly chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_filestat_get() {
    return {
      ret: wasi.ERRNO_SUCCESS,
      filestat: new wasi.Filestat(this.ino, wasi.FILETYPE_CHARACTER_DEVICE, BigInt(0)),
    };
  }

  fd_write(data: Uint8Array) {
    // The shim hands over a copy of guest memory already, so this keeps the reference.
    this.chunks.push(data);
    this.#length += data.byteLength;
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }

  /** Takes the bytes out, leaving the stream empty for the next run. */
  take(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    this.chunks.length = 0;
    this.#length = 0;
    return out;
  }
}

/**
 * Reads a `Blob` synchronously, a window at a time.
 *
 * `FileReaderSync` is the only synchronous read the web offers, and a wasm import cannot
 * await, which is why the engine runs in a Worker at all.
 */
class BlobReader {
  readonly reader = new FileReaderSync();
  #start = -1;
  #cache = new Uint8Array(0);
  #calls = 0;

  get calls(): number {
    return this.#calls;
  }

  read(blob: Blob, offset: number, length: number): Uint8Array {
    if (offset < this.#start || offset + length > this.#start + this.#cache.byteLength) {
      const aligned = Math.max(0, Math.floor(offset / WINDOW) * WINDOW);
      // A range straddling a window boundary is served from the window that starts before it.
      const want = Math.min(Math.max(WINDOW, offset + length - aligned), blob.size - aligned);
      this.#cache = new Uint8Array(this.reader.readAsArrayBuffer(blob.slice(aligned, aligned + want)));
      this.#start = aligned;
      this.#calls += 1;
    }
    const begin = offset - this.#start;
    return this.#cache.subarray(begin, begin + length);
  }
}

/** The user's archive, as a read-only file the guest can open and seek in. */
class BlobFile extends File {
  readonly blob: Blob;
  readonly reader = new BlobReader();

  constructor(blob: Blob) {
    // `File` copies the array it is given; an empty one costs nothing, and every read path
    // this class cares about is overridden below.
    super(new Uint8Array(0), { readonly: true });
    this.blob = blob;
  }

  override get size(): bigint {
    return BigInt(this.blob.size);
  }

  override stat(): FilestatShape {
    return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, this.size);
  }

  override path_open(oflags: number): { ret: number; fd_obj: OpenBlob | null } {
    if (oflags & wasi.OFLAGS_TRUNC) return { ret: wasi.ERRNO_PERM, fd_obj: null };
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: new OpenBlob(this) };
  }
}

/** An open handle on [`BlobFile`], with the windowed reader behind it. */
class OpenBlob extends Fd {
  #file: BlobFile;
  #position = 0n;

  constructor(file: BlobFile) {
    super();
    this.#file = file;
  }

  #at(offset: number, length: number): Uint8Array {
    const end = Math.min(offset + length, this.#file.blob.size);
    // At the end of the file there is nothing to read, and asking a Blob for an empty slice
    // is a backend call for zero bytes.
    if (offset >= end || length === 0) return new Uint8Array(0);
    return this.#file.reader.read(this.#file.blob, offset, end - offset);
  }

  fd_fdstat_get() {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0);
    fdstat.fs_rights_base = BigInt(
      wasi.RIGHTS_FD_READ | wasi.RIGHTS_FD_SEEK | wasi.RIGHTS_FD_TELL | wasi.RIGHTS_FD_FILESTAT_GET,
    );
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  fd_filestat_get() {
    return { ret: wasi.ERRNO_SUCCESS, filestat: this.#file.stat() };
  }

  fd_read(size: number) {
    const data = this.#at(Number(this.#position), size);
    this.#position += BigInt(data.byteLength);
    return { ret: wasi.ERRNO_SUCCESS, data };
  }

  fd_pread(size: number, offset: bigint) {
    return { ret: wasi.ERRNO_SUCCESS, data: this.#at(Number(offset), size) };
  }

  fd_seek(offset: bigint, whence: number) {
    const size = this.#file.size;
    const base = whence === wasi.WHENCE_SET ? 0n : whence === wasi.WHENCE_CUR ? this.#position : size;
    const next = base + offset;
    if (next < 0n) return { ret: wasi.ERRNO_INVAL, offset: 0n };
    this.#position = next;
    return { ret: wasi.ERRNO_SUCCESS, offset: next };
  }

  fd_tell() {
    return { ret: wasi.ERRNO_SUCCESS, offset: this.#position };
  }
}

export interface WasiRunRequest {
  /**
   * The compiled module, so a run does not pay for compiling 17 MB of wasm again. Bytes are
   * accepted too, for a caller that has not compiled it yet.
   */
  readonly wasm: WebAssembly.Module | ArrayBuffer;
  /** The archive to mount. Only the mount path in `argv` will resolve. */
  readonly file: Blob;
  /** The command line after the program name. */
  readonly args: readonly string[];
  /** Host policy, in the environment rather than in the command line. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Extra files to place in the mount directory beside the archive, by name.
   *
   * This is how an entry pulled out of the archive (a native library, say) reaches the guest:
   * it is mounted, not passed through the command line, so a path in `args` still names a
   * real file the program opens.
   */
  readonly mounts?: ReadonlyMap<string, Uint8Array>;
  /**
   * Files the sandbox can read and cannot write: the shared virtual filesystem.
   *
   * Separate from `mounts` because the two answer different questions afterwards — what a
   * program produced is exactly the writable side, and a shared file that a program merely
   * opened is not something to store again.
   */
  readonly readOnly?: ReadonlyMap<string, Uint8Array>;
}

/** What any program run reports: the two streams, the status, and the memory high mark. */
export interface WasiProgramResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  /** Linear memory in use after the run: wasm memory never shrinks, so this is a high mark. */
  readonly memoryBytes: number;
}

export interface WasiRunResult extends WasiProgramResult {
  /** Backend reads the window did not absorb, which is the host cost of the run. */
  readonly reads: number;
  /**
   * The writable side of the filesystem after the run, by name.
   *
   * A guest can write: `rasc -o /work/out.xml` and Kuna's `project` both do. Whatever is here
   * is new or changed, because the shared files are mounted read-only on purpose.
   */
  readonly written: Map<string, Uint8Array>;
}

/**
 * Runs one command line and returns what a terminal would have seen.
 *
 * Traps are not decoded here: the guest's panic hook writes its message to stderr before
 * `panic = "abort"` turns the process into a trap, and that message is in `stderr` for the
 * caller to read.
 */
export async function runCommand(request: WasiRunRequest): Promise<WasiRunResult> {
  if (request.wasm instanceof WebAssembly.Module) return runCommandSync(request);
  const module = await WebAssembly.compile(request.wasm);
  return runCommandSync({ ...request, wasm: module });
}

/**
 * The same run, started and finished without awaiting anything.
 *
 * This is what a code sandbox needs: an interpreter running *inside* a worker cannot await,
 * so the engine call it makes has to be a plain function call all the way down. It works
 * because `new WebAssembly.Instance` is synchronous (the async form is only required on a
 * page's main thread, and only for modules over 4 KB), and because every byte the guest
 * reads comes from a `Blob` read through `FileReaderSync`.
 */
export function runCommandSync(request: WasiRunRequest): WasiRunResult {
  const entries = new Map<string, Uint8Array | Blob>([["archive.apk", request.file]]);
  for (const [name, bytes] of request.mounts ?? []) entries.set(name, bytes);
  const writable = treeFromPaths(entries);
  const shared = treeFromPaths(request.readOnly ?? [], { readOnly: true });

  // One tree, the writable side winning any collision: a program that produced a file with a
  // shared name means its own copy, not the shared one.
  const tree = new Map([...shared.tree, ...writable.tree]);
  const result = runProgramSync({
    wasm: request.wasm,
    name: "rasc",
    args: request.args,
    ...(request.env ? { env: request.env } : {}),
    mounts: [{ path: MOUNT, tree }],
  });

  return {
    ...result,
    // Backend reads that the window did not absorb: the host's own cost, not the engine's.
    reads: writable.readers.reduce((total, reader) => total + reader.calls, 0),
    written: collect(writable.files, request.mounts),
  };
}

/**
 * The writable leaves as plain bytes.
 *
 * The `File` objects belong to the shim and are reused across a run, so the bytes are copied
 * out rather than referenced: a program that keeps writing keeps reallocating them.
 */
function collect(
  files: ReadonlyMap<string, File>,
  mounts: ReadonlyMap<string, Uint8Array> | undefined,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [name, bytes] of mounts ?? []) out.set(name, bytes);
  for (const [name, file] of files) out.set(name, new Uint8Array(file.data));
  return out;
}
