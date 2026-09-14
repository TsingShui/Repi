/**
 * SHA-256, one chunk at a time.
 *
 * The page has no streaming hash: `crypto.subtle.digest` wants the whole buffer,
 * and reading a 300 MB APK into the page to fingerprint it would undo the reason
 * the Rasc engine reads byte ranges instead. This is the algorithm itself, which
 * is worth the eighty lines here rather than a runtime dependency, and it is
 * checkable against the published test vectors in `npm run check:analysis`.
 *
 * Text is not handled: every caller has bytes, and a string's encoding is the
 * caller's business, not the digest's.
 */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export class Sha256 {
  readonly #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  readonly #block = new Uint8Array(64);
  readonly #words = new Uint32Array(64);
  readonly #view = new DataView(this.#block.buffer);
  #buffered = 0;
  #length = 0;
  #finished = false;

  /** Feeds the next bytes. May be called with any chunk size, including zero. */
  update(bytes: Uint8Array): void {
    if (this.#finished) throw new Error("This digest is already finished.");
    this.#length += bytes.length;
    let at = 0;

    if (this.#buffered > 0) {
      const take = Math.min(64 - this.#buffered, bytes.length);
      this.#block.set(bytes.subarray(0, take), this.#buffered);
      this.#buffered += take;
      at = take;
      if (this.#buffered < 64) return;
      this.#compress();
      this.#buffered = 0;
    }

    while (at + 64 <= bytes.length) {
      this.#block.set(bytes.subarray(at, at + 64));
      this.#compress();
      at += 64;
    }

    if (at < bytes.length) {
      this.#block.set(bytes.subarray(at), 0);
      this.#buffered = bytes.length - at;
    }
  }

  /** The lowercase hexadecimal digest. The instance cannot be updated afterwards. */
  digest(): string {
    if (this.#finished) throw new Error("This digest is already finished.");
    this.#finished = true;

    // The length is in bits, and it is written as a 64-bit big-endian count.
    const bits = this.#length * 8;
    this.#block[this.#buffered] = 0x80;
    this.#buffered += 1;
    if (this.#buffered > 56) {
      this.#block.fill(0, this.#buffered);
      this.#compress();
      this.#buffered = 0;
    }
    this.#block.fill(0, this.#buffered, 56);
    // Above 2^53 bytes the float loses precision, which no file in this
    // application reaches; the high word is still written correctly.
    this.#view.setUint32(56, Math.floor(bits / 0x1_0000_0000));
    this.#view.setUint32(60, bits >>> 0);
    this.#compress();

    let out = "";
    for (const value of this.#state) out += value.toString(16).padStart(8, "0");
    return out;
  }

  #compress(): void {
    const words = this.#words;
    for (let index = 0; index < 16; index += 1) words[index] = this.#view.getUint32(index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.#state as unknown as [number, number, number, number, number, number, number, number];

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    const state = this.#state;
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
}

/** How much of a file is read between event-loop turns. */
const CHUNK_BYTES = 4 << 20;

/**
 * The digest of a file, without ever holding the whole thing.
 *
 * The reads are awaited between chunks, so a large file does not freeze the page
 * while it is hashed: the work happens in the same frames the rest of the
 * interface is drawn in.
 */
export async function sha256File(file: Blob, onProgress?: (fraction: number) => void): Promise<string> {
  const digest = new Sha256();
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    digest.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    if (file.size > 0) onProgress?.(end / file.size);
  }
  return digest.digest();
}
