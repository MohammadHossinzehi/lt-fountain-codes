// Monte Carlo measurement of reception overhead.
//
// "Overhead" is how many symbols beyond k a receiver needs: needed = k(1+e).
// For a rateless code over an erasure channel the loss rate does not change
// this number, only how long you wait for it, so we measure the clean
// stream and model loss separately in the demo.

import { LTDecoder } from './decoder.js';
import { LTEncoder } from './encoder.js';
import { mulberry32 } from './prng.js';

/** Feed symbols until decoding completes; return what it took. */
export function measureOverhead({ k, blockSize = 8, c, delta, mode = 'ml', seed = 1, verify = true, maxFactor = 4 }) {
  const rng = mulberry32(seed ^ 0xa5a5a5a5);
  const data = new Uint8Array(k * blockSize);
  for (let i = 0; i < data.length; i++) data[i] = (rng() * 256) | 0;
  const enc = new LTEncoder(data, { blockSize, seed, c, delta });
  const dec = new LTDecoder(enc.params, { mode });
  const limit = Math.ceil(k * maxFactor) + 50;
  let id = 0;
  while (!dec.complete) {
    if (id > limit) throw new Error(`no decode after ${limit} symbols (k=${k})`);
    const sym = enc.symbol(id++);
    dec.addSymbol(sym.id, sym.data);
  }
  if (verify) {
    const out = dec.result();
    for (let i = 0; i < data.length; i++) if (out[i] !== data[i]) throw new Error('decoded data mismatch');
  }
  return { needed: dec.received, overhead: (dec.received - k) / k, solvedBy: dec.solvedBy, residual: dec.stats.residualSize };
}

export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function runTrials({ k, trials = 50, baseSeed = 1, ...rest }) {
  const samples = [];
  for (let t = 0; t < trials; t++) samples.push(measureOverhead({ k, seed: baseSeed + t, ...rest }).needed);
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const ov = (n) => (n - k) / k;
  return {
    k,
    trials,
    samples,
    mean,
    meanOverhead: ov(mean),
    p50: ov(quantile(sorted, 0.5)),
    p95: ov(quantile(sorted, 0.95)),
    max: ov(sorted[sorted.length - 1]),
    min: ov(sorted[0]),
  };
}

/**
 * Empirical P(decode fails | exactly n = k(1+e) symbols received), from
 * the trial samples, for each overhead e in `overheads`.
 */
export function failureCurve(samples, k, overheads) {
  return overheads.map((e) => {
    const n = Math.floor(k * (1 + e));
    const fails = samples.filter((s) => s > n).length;
    return { overhead: e, n, failureRate: fails / samples.length };
  });
}
