// Rateless encoder: an endless stream of symbols from a fixed message.

import { xorInto } from './bytes.js';
import { LTCode } from './code.js';

export class LTEncoder {
  /**
   * @param {Uint8Array} data  message to protect
   * @param {object} [opts]    blockSize, seed, c, delta (see DEFAULTS)
   */
  constructor(data, opts = {}) {
    if (!(data instanceof Uint8Array)) throw new TypeError('data must be a Uint8Array');
    this.code = new LTCode({ ...opts, length: data.length });
    const { k, blockSize } = this.code;
    // One contiguous, zero padded buffer; blocks are views into it.
    this.store = new Uint8Array(k * blockSize);
    this.store.set(data);
  }

  get k() {
    return this.code.k;
  }

  get params() {
    return this.code.params;
  }

  block(i) {
    const T = this.code.blockSize;
    return this.store.subarray(i * T, (i + 1) * T);
  }

  /** Encoded symbol number `id` (any uint32). Pure: same id, same bytes. */
  symbol(id) {
    const neighbors = this.code.neighbors(id);
    const data = new Uint8Array(this.code.blockSize);
    for (const n of neighbors) xorInto(data, this.block(n));
    return { id: id >>> 0, neighbors, data };
  }

  /** Infinite generator of symbols starting at `start`. */
  *symbols(start = 0) {
    for (let id = start >>> 0; ; id = (id + 1) >>> 0) yield this.symbol(id);
  }
}
