/**
 * Deterministic pseudo-random numbers (sfc32, seeded from a string). The same seed always produces the same
 * airport day, so demos and tests are reproducible. Not for security use.
 */

function hashSeed(seed: string): [number, number, number, number] {
  // cyrb128: spreads the seed string over four 32-bit words.
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (const ch of seed) {
    const k = ch.codePointAt(0) ?? 0;
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    [this.a, this.b, this.c, this.d] = hashSeed(seed);
    for (let i = 0; i < 12; i += 1) this.next();
  }

  /** A child generator: independent stream, still determined by the parent seed. */
  fork(label: string): Rng {
    return new Rng(`${this.next()}:${label}`);
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  float(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Approximately normal (sum of uniforms), clamped to [min, max]. */
  normal(mean: number, sd: number, min = -Infinity, max = Infinity): number {
    const z = this.next() + this.next() + this.next() + this.next() + this.next() + this.next() - 3;
    return Math.min(max, Math.max(min, mean + z * sd * Math.SQRT2));
  }

  pick<T>(items: readonly T[]): T {
    const item = items.at(Math.floor(this.next() * items.length));
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }

  /** Weighted choice; weights need not sum to 1. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    const total = items.reduce((sum, item) => sum + Math.max(0, weight(item)), 0);
    let r = this.next() * total;
    for (const item of items) {
      r -= Math.max(0, weight(item));
      if (r < 0) return item;
    }
    const last = items.at(-1);
    if (last === undefined) throw new Error('weighted pick from an empty list');
    return last;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const a = out.at(i) as T;
      const b = out.at(j) as T;
      out.splice(i, 1, b);
      out.splice(j, 1, a);
    }
    return out;
  }

  /** Random uppercase letters, e.g. for registrations. */
  letters(n: number): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let out = '';
    for (let i = 0; i < n; i += 1) out += alphabet.charAt(Math.floor(this.next() * alphabet.length));
    return out;
  }
}
