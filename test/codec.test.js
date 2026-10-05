import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LTDecoder, LTEncoder, decodePacket, encodePacket } from '../src/index.js';
import { mulberry32 } from '../src/prng.js';

function randomBytes(n, seed) {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => (rng() * 256) | 0);
}

function decodeStream(enc, ids, mode) {
  const dec = new LTDecoder(enc.params, { mode });
  for (const id of ids) {
    const s = enc.symbol(id);
    if (dec.addSymbol(s.id, s.data)) break;
  }
  return dec;
}

function* naturals(start = 0) {
  for (let i = start; ; i++) yield i;
}

test('symbols are pure functions of (params, id)', () => {
  const data = randomBytes(5000, 1);
  const a = new LTEncoder(data, { blockSize: 100, seed: 9 });
  const b = new LTEncoder(data, { blockSize: 100, seed: 9 });
  for (let id = 0; id < 50; id++) assert.deepEqual(a.symbol(id).data, b.symbol(id).data);
  const c = new LTEncoder(data, { blockSize: 100, seed: 10 });
  let differ = 0;
  for (let id = 0; id < 50; id++) if (a.symbol(id).neighbors.join() !== c.symbol(id).neighbors.join()) differ++;
  assert.ok(differ > 40, 'a different seed should give a different graph');
});

test('a symbol is the XOR of its neighbour blocks', () => {
  const data = randomBytes(64 * 20, 2);
  const enc = new LTEncoder(data, { blockSize: 64 });
  for (let id = 0; id < 30; id++) {
    const s = enc.symbol(id);
    const expect = new Uint8Array(64);
    for (const n of s.neighbors) for (let i = 0; i < 64; i++) expect[i] ^= data[n * 64 + i];
    assert.deepEqual(s.data, expect);
  }
});

for (const mode of ['peeling', 'ml']) {
  test(`[${mode}] round trip for awkward sizes`, () => {
    for (const [n, T] of [[0, 16], [1, 16], [16, 16], [17, 16], [1000, 7], [4096, 64], [100003, 1024]]) {
      const data = randomBytes(n, n + 1);
      const enc = new LTEncoder(data, { blockSize: T, seed: n });
      const dec = decodeStream(enc, naturals(), mode);
      assert.ok(dec.complete, `n=${n} T=${T}`);
      assert.deepEqual(dec.result(), data);
    }
  });

  test(`[${mode}] survives 50% random loss and arbitrary order`, () => {
    const data = randomBytes(30000, 3);
    const enc = new LTEncoder(data, { blockSize: 100, seed: 77 });
    const rng = mulberry32(5);
    const ids = [];
    for (let id = 0; ids.length < enc.k * 3; id++) if (rng() >= 0.5) ids.push(id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const dec = decodeStream(enc, ids, mode);
    assert.ok(dec.complete);
    assert.deepEqual(dec.result(), data);
  });
}

test('duplicates are counted and ignored', () => {
  const data = randomBytes(2000, 4);
  const enc = new LTEncoder(data, { blockSize: 50 });
  const dec = new LTDecoder(enc.params, { mode: 'peeling' });
  const s = enc.symbol(0);
  dec.addSymbol(0, s.data);
  dec.addSymbol(0, s.data);
  dec.addSymbol(0, s.data);
  assert.equal(dec.stats.received, 1);
  assert.equal(dec.stats.duplicates, 2);
});

test('result() before completion throws; wrong block size throws', () => {
  const enc = new LTEncoder(randomBytes(1000, 5), { blockSize: 10 });
  const dec = new LTDecoder(enc.params);
  assert.throws(() => dec.result(), /not complete/);
  assert.throws(() => dec.addSymbol(0, new Uint8Array(9)), RangeError);
});

test('ML never needs more symbols than peeling on the same stream', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const data = randomBytes(300 * 8, seed);
    const enc = new LTEncoder(data, { blockSize: 8, seed });
    const p = decodeStream(enc, naturals(), 'peeling');
    const m = decodeStream(enc, naturals(), 'ml');
    assert.ok(m.received <= p.received, `seed ${seed}: ml ${m.received} > peeling ${p.received}`);
    assert.ok(m.received >= enc.k, 'cannot beat k symbols');
    assert.deepEqual(m.result(), data);
  }
});

test('ML completes at exactly the symbol where rank first reaches k', () => {
  const data = randomBytes(200 * 4, 8);
  const enc = new LTEncoder(data, { blockSize: 4, seed: 8 });
  const dec = new LTDecoder(enc.params, { mode: 'ml' });
  let id = 0;
  while (!dec.complete) {
    const before = dec.tracker.rank;
    const s = enc.symbol(id++);
    dec.addSymbol(s.id, s.data);
    if (!dec.complete) assert.ok(dec.tracker.rank < enc.k);
    else assert.ok(before < enc.k || dec.solvedBy === 'peeling');
  }
  assert.equal(dec.tracker.rank, enc.k);
});

test('auto mode picks ml for small k and peeling for large k', () => {
  assert.equal(new LTDecoder({ length: 1000, blockSize: 10 }).mode, 'ml');
  assert.equal(new LTDecoder({ length: 100000, blockSize: 10 }).mode, 'peeling');
  assert.throws(() => new LTDecoder({ length: 10, blockSize: 1 }, { mode: 'magic' }), RangeError);
});

test('end to end through the wire format', () => {
  const data = new TextEncoder().encode('Fountain codes turn packet loss into waiting. '.repeat(400));
  const enc = new LTEncoder(data, { blockSize: 256, seed: 1234 });
  let dec = null;
  for (let id = 0; ; id += 3) {
    // every third packet only: 66% loss
    const wire = encodePacket(enc.code, id, enc.symbol(id).data);
    const pkt = decodePacket(wire);
    dec ??= new LTDecoder(pkt.params);
    if (dec.addSymbol(pkt.id, pkt.data)) break;
  }
  assert.deepEqual(dec.result(), data);
});
