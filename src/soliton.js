// Degree distributions for LT codes (Luby, "LT Codes", FOCS 2002).
//
// Every encoded symbol is the XOR of `d` source blocks, where `d` is drawn
// from a degree distribution. The distribution decides everything: too many
// low degree symbols and you waste packets on blocks you already have, too
// few and the peeling decoder runs out of degree one symbols ("the ripple
// dies") before it finishes.
//
// All pmfs are returned as Float64Array of length k + 1 with index 0 unused,
// so pmf[d] is the probability of degree d.

/**
 * Ideal soliton: rho(1) = 1/k, rho(d) = 1 / (d (d - 1)).
 * In expectation it releases exactly one new degree one symbol per decoded
 * block, which is optimal on paper and fragile in practice: any random
 * fluctuation empties the ripple.
 */
export function idealSoliton(k) {
  assertK(k);
  const p = new Float64Array(k + 1);
  p[1] = 1 / k;
  for (let d = 2; d <= k; d++) p[d] = 1 / (d * (d - 1));
  return p;
}

/**
 * Robust soliton: ideal soliton plus an extra term tau that
 *   (a) boosts low degrees so the ripple has an expected size of about
 *       R = c * ln(k / delta) * sqrt(k), and
 *   (b) adds a spike at d = k / R so that every source block is covered.
 * With probability at least 1 - delta, k + O(sqrt(k) ln^2(k / delta))
 * symbols suffice for the peeling decoder.
 *
 * Returns { pmf, R, spike, beta } so callers can inspect the shape.
 */
export function robustSoliton(k, c = 0.03, delta = 0.5) {
  assertK(k);
  if (!(c > 0)) throw new RangeError('c must be > 0');
  if (!(delta > 0 && delta < 1)) throw new RangeError('delta must be in (0, 1)');
  const rho = idealSoliton(k);
  if (k === 1) return { pmf: rho, R: 1, spike: 1, beta: 1 };

  const R = c * Math.log(k / delta) * Math.sqrt(k);
  // Clamp the spike into [1, k]; for tiny k, R can exceed k.
  const spike = Math.min(k, Math.max(1, Math.floor(k / R)));
  const tau = new Float64Array(k + 1);
  for (let d = 1; d < spike; d++) tau[d] = R / (d * k);
  tau[spike] += Math.max(0, (R * Math.log(R / delta)) / k);

  let beta = 0;
  for (let d = 1; d <= k; d++) beta += rho[d] + tau[d];
  const pmf = new Float64Array(k + 1);
  for (let d = 1; d <= k; d++) pmf[d] = (rho[d] + tau[d]) / beta;
  return { pmf, R, spike, beta };
}

/** Mean of a pmf indexed from 1. */
export function meanDegree(pmf) {
  let m = 0;
  for (let d = 1; d < pmf.length; d++) m += d * pmf[d];
  return m;
}

/**
 * Inverse CDF sampler. Building the CDF is O(k); each draw is a binary
 * search, O(log k).
 */
export class DegreeSampler {
  constructor(pmf) {
    const k = pmf.length - 1;
    this.k = k;
    this.cdf = new Float64Array(k + 1);
    let acc = 0;
    for (let d = 1; d <= k; d++) {
      acc += pmf[d];
      this.cdf[d] = acc;
    }
    // Guard against floating point drift leaving the tail below 1.
    this.cdf[k] = Infinity;
  }

  /** Map a uniform u in [0, 1) to a degree in [1, k]. */
  sample(u) {
    let lo = 1;
    let hi = this.k;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cdf[mid] > u) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}

function assertK(k) {
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer');
}
