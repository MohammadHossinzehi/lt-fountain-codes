// The shared "code description": everything both ends must agree on.
//
// An LT code is fully determined by (length, blockSize, seed, c, delta).
// From those, encoder and decoder independently rebuild the same degree
// sampler and therefore the same bipartite graph between source blocks and
// encoded symbols. Nothing about the graph is ever transmitted.

import { mulberry32, pickDistinct, symbolSeed } from './prng.js';
import { DegreeSampler, robustSoliton } from './soliton.js';

export const DEFAULTS = Object.freeze({
  blockSize: 1024,
  seed: 0x5eed1e55,
  c: 0.03,
  delta: 0.5,
});

export class LTCode {
  constructor({ length, blockSize = DEFAULTS.blockSize, seed = DEFAULTS.seed, c = DEFAULTS.c, delta = DEFAULTS.delta }) {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('length must be a non negative integer');
    if (!Number.isInteger(blockSize) || blockSize < 1) throw new RangeError('blockSize must be a positive integer');
    this.length = length;
    this.blockSize = blockSize;
    this.seed = seed >>> 0;
    // Packets store c and delta as float32. Round here too, otherwise the
    // encoder and a decoder that parsed a packet could build pmfs that
    // differ in the last bit and silently disagree about degrees.
    this.c = Math.fround(c);
    this.delta = Math.fround(delta);
    this.k = Math.max(1, Math.ceil(length / blockSize));
    this.distribution = robustSoliton(this.k, this.c, this.delta);
    this.sampler = new DegreeSampler(this.distribution.pmf);
  }

  /** Sorted source block indices XOR'd together to form symbol `id`. */
  neighbors(id) {
    const rng = mulberry32(symbolSeed(this.seed, id));
    const d = this.sampler.sample(rng());
    return pickDistinct(this.k, d, rng);
  }

  get params() {
    return { length: this.length, blockSize: this.blockSize, seed: this.seed, c: this.c, delta: this.delta };
  }
}

export function sameParams(a, b) {
  return (
    a.length === b.length &&
    a.blockSize === b.blockSize &&
    a.seed >>> 0 === b.seed >>> 0 &&
    Math.fround(a.c) === Math.fround(b.c) &&
    Math.fround(a.delta) === Math.fround(b.delta)
  );
}
