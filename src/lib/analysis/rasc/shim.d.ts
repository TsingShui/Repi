/**
 * Types for `@bjorn3/browser_wasi_shim`, the WASI preview1 implementation both engines run on.
 *
 * The shim is vendored under Kuna's tree (`src/vendor/kuna/vendor/browser_wasi_shim`) and is
 * refreshed by `npm run build:kuna`, so nothing may be placed beside it. It ships `typings/`
 * for its own internal imports, but a `dist/*.js` path does not resolve to them, and Rasc —
 * the second engine to use it — declares the surface it needs here instead. One shim, one
 * copy, and each engine describes the part it leans on.
 *
 * Only what `wasi.ts` uses is declared: a wider copy would be a second description of the
 * shim that nobody maintains.
 */
declare module "*/browser_wasi_shim/dist/index.js" {
  export class Inode {
    readonly ino: bigint;
  }

  export class Fd extends Inode {
    fd_read(size: number): { ret: number; data: Uint8Array };
    fd_pread(size: number, offset: bigint): { ret: number; data: Uint8Array };
    fd_seek(offset: bigint, whence: number): { ret: number; offset: bigint };
    fd_tell(): { ret: number; offset: bigint };
    fd_write(data: Uint8Array): { ret: number; nwritten: number };
    fd_fdstat_get(): { ret: number; fdstat: FdstatShape };
    fd_filestat_get(): { ret: number; filestat: FilestatShape };
  }

  export class File extends Inode {
    constructor(data: Uint8Array | ArrayBuffer, options?: { readonly?: boolean });
    readonly data: Uint8Array;
    get size(): bigint;
    stat(): FilestatShape;
    path_open(oflags: number, fs_rights_base?: bigint, fd_flags?: number): {
      ret: number;
      fd_obj: Fd | null;
    };
  }

  export class Directory extends Inode {
    readonly contents: Map<string, Inode>;
    constructor(contents: Map<string, Inode>);
  }

  export class OpenFile extends Fd {
    constructor(file: File);
  }

  export class OpenDirectory extends Fd {
    constructor(dir: Directory);
  }

  /** A directory the guest can see; it is an `Fd` (the preopen itself) over a `Directory`. */
  export class PreopenDirectory extends OpenDirectory {
    constructor(name: string, contents: Map<string, Inode>);
  }

  export class ConsoleStdout extends Fd {
    static lineBuffered(write: (line: string) => void): ConsoleStdout;
    constructor(write: (buffer: Uint8Array) => void);
  }

  /**
   * `Filestat` and `Fdstat` are not exports of the shim's index: they live under the `wasi`
   * namespace below (`wasi_defs.js`), which is where both the constructor calls and the
   * return types in this file reach them.
   */
  export interface FilestatShape {
    readonly filetype: number;
    readonly size: bigint;
  }

  export interface FdstatShape {
    fs_rights_base: bigint;
    fs_rights_inherited: bigint;
  }

  export class WASI {
    constructor(args: string[], env: string[], fds: Fd[], options?: { debug?: boolean });
    readonly wasiImport: WebAssembly.Imports["wasi_snapshot_preview1"];
    /** Runs `_start` and returns the exit code; a trap is re-thrown. */
    start(instance: WebAssembly.Instance): number;
  }

  export const wasi: {
    readonly ERRNO_SUCCESS: number;
    readonly ERRNO_INVAL: number;
    readonly ERRNO_PERM: number;
    readonly FILETYPE_REGULAR_FILE: number;
    readonly FILETYPE_CHARACTER_DEVICE: number;
    readonly RIGHTS_FD_READ: number;
    readonly RIGHTS_FD_SEEK: number;
    readonly RIGHTS_FD_TELL: number;
    readonly RIGHTS_FD_WRITE: number;
    readonly RIGHTS_FD_FILESTAT_GET: number;
    readonly OFLAGS_TRUNC: number;
    readonly WHENCE_SET: number;
    readonly WHENCE_CUR: number;
    readonly WHENCE_END: number;
    readonly Fdstat: new (filetype: number, flags: number) => FdstatShape;
    readonly Filestat: new (ino: bigint, filetype: number, size: bigint) => FilestatShape;
  };
}
