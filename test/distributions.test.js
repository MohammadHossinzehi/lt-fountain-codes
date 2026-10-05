import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mix32, mulberry32, pickDistinct, symbolSeed } from '../src/prng.js';
import { DegreeSampler, idealSoliton, meanDegree, robustSoliton } from '../src/soliton.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('mulberry32 is roughly uniform (chi-square, 16 bins)', () => {
  const rng = mulberry32(99);
  const bins = new Array(16).fill(0);
  const n = 160000;
  for (let i = 0; i < n; i++) bins[Math.floor(rng() * 16)]++;
  const exp = n / 16;
  const chi = bins.reduce((acc, o) => acc + (o - exp) ** 2 / exp, 0);
  assert.ok(chi < 37.7, `chi2=${chi}`); // p = 0.001 critical value for 15 dof
});

test('symbol seeds differ across ids and streams', () => {
  const seen = new Set();
  for (let id = 0; id < 5000; id++) seen.add(symbolSeed(1, id));
  assert.equal(seen.size, 5000);
  assert.notEqual(symbolSeed(1, 7), symbolSeed(2, 7));
  assert.notEqual(mix32(0), mix32(1));
});

test('pickDistinct returns d sorted distinct values in range', () => {
  const rng = mulberry32(5);
  for (const [k, d] of [[1, 1], [10, 10], [100, 3], [1000, 50]]) {
    const p = pickDistinct(k, d, rng);
    assert.equal(p.length, d);
    for (let i = 0; i < d; i++) {
      assert.ok(p[i] >= 0 && p[i] < k);
      if (i) assert.ok(p[i] > p[i - 1]);
    }
  }
  assert.throws(() => pickDistinct(3, 4, rng), RangeError);
});

test('pickDistinct is unbiased across positions', () => {
  const rng = mulberry32(17);
  const k = 10;
  const counts = new Array(k).fill(0);
  for (let t = 0; t < 20000; t++) for (const v of pickDistinct(k, 3, rng)) counts[v]++;
  for (const c of counts) assert.ok(Math.abs(c - 6000) < 400, `count ${c}`);
});

test('ideal soliton sums to 1 and has the textbook shape', () => {
  for (const k of [1, 2, 10, 1000]) {
    const p = idealSoliton(k);
    assert.ok(Math.abs(sum(p) - 1) < 1e-12);
  }
  const p = idealSoliton(100);
  assert.equal(p[1], 0.01);
  assert.equal(p[2], 0.5);
  assert.ok(Math.abs(p[10] - 1 / 90) < 1e-15);
});

test('robust soliton is a valid pmf with a spike at k/R', () => {
  for (const k of [1, 2, 5, 50, 1000, 10000]) {
    const { pmf, spike, R } = robustSoliton(k, 0.03, 0.5);
    assert.ok(Math.abs(sum(pmf) - 1) < 1e-12, `k=${k}`);
    for (const x of pmf) assert.ok(x >= 0);
    if (k >= 1000) {
      assert.equal(spike, Math.floor(k / R));
      assert.ok(pmf[spike] > pmf[spike - 1] && pmf[spike] > pmf[spike + 1]);
    }
  }
});

test('robust soliton puts more mass on degree 1 than ideal soliton', () => {
  const k = 1000;
  assert.ok(robustSoliton(k).pmf[1] > idealSoliton(k)[1] * 2);
  // mean degree grows roughly like ln(k)
  assert.ok(meanDegree(robustSoliton(10000).pmf) > meanDegree(robustSoliton(100).pmf));
});

test('robust soliton rejects bad parameters', () => {
  assert.throws(() => robustSoliton(0), RangeError);
  assert.throws(() => robustSoliton(10, -1), RangeError);
  assert.throws(() => robustSoliton(10, 0.1, 1), RangeError);
});

test('DegreeSampler matches its pmf empirically', () => {
  const { pmf } = robustSoliton(200, 0.05, 0.5);
  const s = new DegreeSampler(pmf);
  const rng = mulberry32(3);
  const n = 200000;
  const counts = new Float64Array(pmf.length);
  for (let i = 0; i < n; i++) counts[s.sample(rng())]++;
  for (const d of [1, 2, 3, 4]) {
    const sd = Math.sqrt((pmf[d] * (1 - pmf[d])) / n);
    assert.ok(Math.abs(counts[d] / n - pmf[d]) < 5 * sd, `degree ${d}`);
  }
  assert.equal(s.sample(0), 1);
  assert.ok(s.sample(0.9999999999) <= 200);
});
