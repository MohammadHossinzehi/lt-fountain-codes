import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RankTracker, getBit, lowestBit, newRow, setBit, solve } from '../src/gf2.js';
import { xorInto } from '../src/bytes.js';
import { mulberry32 } from '../src/prng.js';

// Reference rank by plain Gaussian elimination on arrays of 0/1.
function bruteRank(m, cols) {
  const a = m.map((r) => r.slice());
  let rank = 0;
  for (let c = 0; c < cols; c++) {
    const p = a.findIndex((r, i) => i >= rank && r[c] === 1);
    if (p < 0) continue;
    [a[p], a[rank]] = [a[rank], a[p]];
    for (let i = 0; i < a.length; i++) if (i !== rank && a[i][c]) for (let j = 0; j < cols; j++) a[i][j] ^= a[rank][j];
    rank++;
  }
  return rank;
}

test('bit helpers', () => {
  const r = newRow(70);
  assert.equal(r.length, 3);
  assert.equal(lowestBit(r), -1);
  setBit(r, 69);
  setBit(r, 33);
  assert.equal(getBit(r, 69), 1);
  assert.equal(getBit(r, 68), 0);
  assert.equal(lowestBit(r), 33);
  setBit(r, 31);
  assert.equal(lowestBit(r), 31);
});

test('RankTracker agrees with brute force rank on random matrices', () => {
  const rng = mulberry32(11);
  for (let trial = 0; trial < 60; trial++) {
    const cols = 1 + Math.floor(rng() * 70);
    const rows = Math.floor(rng() * 90);
    const density = 0.05 + rng() * 0.4;
    const m = [];
    const t = new RankTracker(cols);
    for (let i = 0; i < rows; i++) {
      const row = Array.from({ length: cols }, () => (rng() < density ? 1 : 0));
      m.push(row);
      t.insertIndices(row.flatMap((b, j) => (b ? [j] : [])));
      assert.equal(t.rank, bruteRank(m, cols), `trial ${trial} row ${i}`);
    }
    assert.equal(t.full, t.rank === cols);
  }
});

test('duplicate and dependent rows do not raise rank', () => {
  const t = new RankTracker(4);
  assert.equal(t.insertIndices([0, 1]), true);
  assert.equal(t.insertIndices([1, 2]), true);
  assert.equal(t.insertIndices([0, 2]), false); // sum of the two above
  assert.equal(t.insertIndices([0, 1]), false);
  assert.equal(t.rank, 2);
});

test('solve recovers payloads of a random full rank system', () => {
  const rng = mulberry32(21);
  const cols = 40;
  const T = 13;
  const x = Array.from({ length: cols }, () => Uint8Array.from({ length: T }, () => (rng() * 256) | 0));
  const rows = [];
  const payloads = [];
  const t = new RankTracker(cols);
  while (!t.full) {
    const idx = [];
    for (let j = 0; j < cols; j++) if (rng() < 0.15) idx.push(j);
    t.insertIndices(idx);
    const row = newRow(cols);
    const y = new Uint8Array(T);
    for (const j of idx) {
      setBit(row, j);
      xorInto(y, x[j]);
    }
    rows.push(row);
    payloads.push(y);
  }
  const sol = solve(rows, payloads, cols, xorInto);
  assert.ok(sol);
  for (let j = 0; j < cols; j++) assert.deepEqual(sol[j], x[j]);
});

test('solve reports a singular system', () => {
  const r1 = newRow(3);
  setBit(r1, 0);
  const r2 = newRow(3);
  setBit(r2, 0);
  setBit(r2, 1);
  assert.equal(solve([r1, r2], [new Uint8Array(1), new Uint8Array(1)], 3, xorInto), null);
});
