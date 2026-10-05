// Self describing wire format.
//
// Every packet carries the full code description, so a receiver can join a
// broadcast at any time, with no handshake, and start decoding from the
// first packet it happens to catch. A CRC-32 turns corruption into an
// erasure, which is exactly the channel an LT code is designed for.
//
// Layout (big endian, 44 byte header):
//   0  magic   "LTFC"
//   4  version u8 (1)    5 flags u8 (0)    6 header length u16 (44)
//   8  seed    u32
//  12  k       u32  (redundant with length/blockSize; sanity check)
//  16  blockSize u32
//  20  length  u64
//  28  c       f32
//  32  delta   f32
//  36  symbol id u32
//  40  crc32   u32 over bytes [0, 40) and the payload
//  44  payload (blockSize bytes)

import { LTCode } from './code.js';

export const MAGIC = 0x4c544643; // "LTFC"
export const VERSION = 1;
export const HEADER_SIZE = 44;

export class PacketError extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3, as used by zip and PNG). */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export function encodePacket(params, id, data) {
  const code = params instanceof LTCode ? params : new LTCode(params);
  if (data.length !== code.blockSize) throw new RangeError('payload size must equal blockSize');
  const out = new Uint8Array(HEADER_SIZE + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC);
  v.setUint8(4, VERSION);
  v.setUint8(5, 0);
  v.setUint16(6, HEADER_SIZE);
  v.setUint32(8, code.seed);
  v.setUint32(12, code.k);
  v.setUint32(16, code.blockSize);
  v.setBigUint64(20, BigInt(code.length));
  v.setFloat32(28, code.c);
  v.setFloat32(32, code.delta);
  v.setUint32(36, id >>> 0);
  out.set(data, HEADER_SIZE);
  const crc = crc32(out.subarray(HEADER_SIZE), crc32(out.subarray(0, 40)));
  v.setUint32(40, crc);
  return out;
}

export function decodePacket(bytes) {
  if (bytes.length < HEADER_SIZE) throw new PacketError('packet too short');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== MAGIC) throw new PacketError('bad magic');
  if (v.getUint8(4) !== VERSION) throw new PacketError(`unsupported version ${v.getUint8(4)}`);
  if (v.getUint16(6) !== HEADER_SIZE) throw new PacketError('bad header length');
  const blockSize = v.getUint32(16);
  if (bytes.length !== HEADER_SIZE + blockSize) throw new PacketError('length does not match blockSize');
  const crc = crc32(bytes.subarray(HEADER_SIZE), crc32(bytes.subarray(0, 40)));
  if (crc !== v.getUint32(40)) throw new PacketError('checksum mismatch');
  const length = Number(v.getBigUint64(20));
  const params = {
    length,
    blockSize,
    seed: v.getUint32(8),
    c: v.getFloat32(28),
    delta: v.getFloat32(32),
  };
  const k = Math.max(1, Math.ceil(length / blockSize));
  if (v.getUint32(12) !== k) throw new PacketError('k does not match length/blockSize');
  return { params, id: v.getUint32(36), data: bytes.slice(HEADER_SIZE) };
}
