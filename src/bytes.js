// Byte level helpers shared by the encoder and decoder.

/**
 * dst ^= src, in place. Uses a 32 bit fast path when both views are
 * 4 byte aligned, which is the common case because we allocate block
 * buffers ourselves. Payload XOR is the hot loop of the whole codec.
 */
export function xorInto(dst, src) {
  const n = dst.length;
  if (src.length !== n) throw new RangeError('xorInto: length mismatch');
  let i = 0;
  if ((dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0 && n >= 16) {
    const words = n >>> 2;
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, words);
    const s32 = new Uint32Array(src.buffer, src.byteOffset, words);
    for (let w = 0; w < words; w++) d32[w] ^= s32[w];
    i = words << 2;
  }
  for (; i < n; i++) dst[i] ^= src[i];
  return dst;
}

/** Fresh, 4 byte aligned copy of a Uint8Array. */
export function copyBytes(src) {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}
