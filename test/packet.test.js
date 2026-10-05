import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEADER_SIZE, PacketError, crc32, decodePacket, encodePacket } from '../src/packet.js';
import { LTCode, sameParams } from '../src/code.js';

const enc = new TextEncoder();

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  // incremental == one shot
  const a = enc.encode('hello ');
  const b = enc.encode('world');
  assert.equal(crc32(b, crc32(a)), crc32(enc.encode('hello world')));
});

test('packet round trip preserves params, id and payload', () => {
  const params = { length: 123457, blockSize: 512, seed: 0xdeadbeef, c: 0.07, delta: 0.25 };
  const payload = Uint8Array.from({ length: 512 }, (_, i) => i * 7);
  const pkt = encodePacket(params, 4000000000, payload);
  assert.equal(pkt.length, HEADER_SIZE + 512);
  const got = decodePacket(pkt);
  assert.equal(got.id, 4000000000);
  assert.deepEqual(got.data, payload);
  assert.ok(sameParams(got.params, new LTCode(params).params));
  // float32 rounding is applied consistently on both sides
  assert.equal(got.params.c, Math.fround(0.07));
});

test('every single bit flip is detected', () => {
  const pkt = encodePacket({ length: 40, blockSize: 8 }, 3, new Uint8Array(8).fill(9));
  for (let byte = 0; byte < pkt.length; byte++) {
    for (let bit = 0; bit < 8; bit++) {
      const bad = pkt.slice();
      bad[byte] ^= 1 << bit;
      assert.throws(() => decodePacket(bad), PacketError, `byte ${byte} bit ${bit}`);
    }
  }
});

test('malformed packets are rejected with a reason', () => {
  const pkt = encodePacket({ length: 40, blockSize: 8 }, 0, new Uint8Array(8));
  assert.throws(() => decodePacket(pkt.subarray(0, 10)), /too short/);
  assert.throws(() => decodePacket(pkt.subarray(0, pkt.length - 1)), /blockSize/);
  const magic = pkt.slice();
  magic[0] = 0;
  assert.throws(() => decodePacket(magic), /magic/);
  assert.throws(() => encodePacket({ length: 40, blockSize: 8 }, 0, new Uint8Array(7)), RangeError);
});

test('decoding works on a view into a larger buffer', () => {
  const pkt = encodePacket({ length: 16, blockSize: 16 }, 1, new Uint8Array(16).fill(1));
  const big = new Uint8Array(pkt.length + 3);
  big.set(pkt, 3);
  assert.equal(decodePacket(big.subarray(3)).id, 1);
});
