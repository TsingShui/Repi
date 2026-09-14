/**
 * Deterministic pseudo-randomness for the mock analysis source.
 *
 * The mock has to look the same on every run so screenshots and smoke
 * assertions stay stable, so it uses a seeded generator rather than
 * `Math.random()`.
 */

export interface Random {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
}

/** FNV-1a over a string, used to turn a file identity into a seed. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRandom(seed: number): Random {
  let state = seed >>> 0 || 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick<T>(values: readonly T[]): T {
      const value = values[int(0, values.length - 1)];
      if (value === undefined) throw new Error("Cannot pick from an empty pool");
      return value;
    },
    chance(probability: number): boolean {
      return next() < probability;
    },
  };
}
