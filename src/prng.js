// Deterministic pseudo random numbers.
//
// Encoder and decoder never exchange neighbour lists. They agree on a
// stream seed and each packet carries a 32 bit symbol id; both sides then
// rederive the exact same degree and neighbour set from (seed, id). That
// only works if the generator is fully specified, so we avoid Math.random
// and use small, well known integer mixers instead.

/** SplitMix32 style finaliser: a good avalanche on a single 32 bit word. */
export function mix32(x) {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Derive a per symbol seed from the stream seed and the symbol id. */
export function symbolSeed(streamSeed, id) {
  return mix32((mix32(streamSeed) ^ Math.imul(id >>> 0, 0x9e3779b1)) >>> 0);
}

/**
 * Mulberry32: tiny, fast, passes the usual statistical smoke tests and is
 * more than good enough for choosing graph edges.
 * Returns a function yielding floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Choose `d` distinct integers from [0, k) using Robert Floyd's algorithm:
 * exactly d random draws and O(d) memory, regardless of k.
 * The result is sorted ascending so neighbour lists are canonical.
 */
export function pickDistinct(k, d, rng) {
  if (d > k) throw new RangeError(`cannot pick ${d} distinct values from ${k}`);
  const chosen = new Set();
  for (let j = k - d; j < k; j++) {
    const t = Math.floor(rng() * (j + 1));
    chosen.add(chosen.has(t) ? j : t);
  }
  return Int32Array.from(chosen).sort();
}
