import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureCurve, measureOverhead, quantile, runTrials } from '../src/simulate.js';

test('quantile interpolates', () => {
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('measured overheads are sane and ML beats peeling on average', () => {
  const k = 400;
  const peel = runTrials({ k, trials: 20, mode: 'peeling', blockSize: 4 });
  const ml = runTrials({ k, trials: 20, mode: 'ml', blockSize: 4 });
  assert.ok(ml.min >= 0 && peel.min >= 0);
  assert.ok(ml.meanOverhead < peel.meanOverhead, `ml ${ml.meanOverhead} vs peel ${peel.meanOverhead}`);
  assert.ok(ml.meanOverhead < 0.05, `ml overhead ${ml.meanOverhead}`);
  assert.ok(peel.meanOverhead < 0.5, `peeling overhead ${peel.meanOverhead}`);
});

test('failure curve is monotone non increasing', () => {
  const r = runTrials({ k: 300, trials: 15, mode: 'peeling', blockSize: 4 });
  const curve = failureCurve(r.samples, 300, [0, 0.05, 0.1, 0.2, 0.5, 1]);
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].failureRate <= curve[i - 1].failureRate);
  assert.equal(curve[curve.length - 1].failureRate, 0); // 2k symbols is always plenty at this size
});

test('measureOverhead verifies the payload', () => {
  const r = measureOverhead({ k: 50, mode: 'ml', seed: 3 });
  assert.ok(r.needed >= 50);
  assert.ok(['ml', 'peeling'].includes(r.solvedBy));
});
