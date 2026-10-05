// Linear algebra over GF(2) with packed bitsets.
//
// Decoding an erasure code is solving A x = y where A is the 0/1 matrix of
// "which blocks went into which symbol", addition is XOR and the unknowns
// x are whole blocks. The peeling decoder is a cheap, greedy special case of
// this; Gaussian elimination is the exact (maximum likelihood) solver that
// succeeds as soon as A has full column rank.

export const wordsFor = (bits) => (bits + 31) >>> 5;

export function newRow(bits) {
  return new Uint32Array(wordsFor(bits));
}

export function setBit(row, i) {
  row[i >>> 5] |= 1 << (i & 31);
}

export function getBit(row, i) {
  return (row[i >>> 5] >>> (i & 31)) & 1;
}

export function xorRow(dst, src) {
  for (let w = 0; w < dst.length; w++) dst[w] ^= src[w];
}

/** Index of the lowest set bit, or -1 if the row is zero. */
export function lowestBit(row) {
  for (let w = 0; w < row.length; w++) {
    const v = row[w];
    if (v !== 0) return (w << 5) + (31 - Math.clz32(v & -v));
  }
  return -1;
}

/**
 * Incremental rank tracker.
 *
 * Keeps a reduced basis keyed by pivot column. Each inserted row is reduced
 * against existing pivots; if anything survives it becomes a new basis row.
 * This tells the decoder, the moment it happens, that the received symbols
 * determine every source block, which is what lets us measure the true
 * minimum reception overhead instead of guessing a retry schedule.
 *
 * Coefficient bits only: payloads are touched once, at solve time.
 */
export class RankTracker {
  constructor(cols) {
    this.cols = cols;
    this.rank = 0;
    this.basis = new Array(cols).fill(null);
  }

  /** Insert a row given as a list of column indices. Returns true if rank grew. */
  insertIndices(indices) {
    const row = newRow(this.cols);
    for (const i of indices) row[i >>> 5] ^= 1 << (i & 31);
    return this.insert(row);
  }

  /** Insert a packed row (it is consumed). Returns true if rank grew. */
  insert(row) {
    for (;;) {
      const p = lowestBit(row);
      if (p < 0) return false;
      const b = this.basis[p];
      if (b === null) {
        this.basis[p] = row;
        this.rank++;
        return true;
      }
      xorRow(row, b);
    }
  }

  get full() {
    return this.rank === this.cols;
  }
}

/**
 * Gauss Jordan elimination with payloads.
 *
 * rows:     array of packed coefficient rows over `cols` unknowns
 * payloads: array of Uint8Array, payloads[i] belongs to rows[i]
 *
 * Returns an array `solution` of length cols (Uint8Array per unknown) or
 * null if the system is rank deficient. Inputs are mutated.
 */
export function solve(rows, payloads, cols, xorBytes) {
  const n = rows.length;
  const pivotRow = new Int32Array(cols).fill(-1);
  let r = 0;
  for (let c = 0; c < cols && r < n; c++) {
    let sel = -1;
    for (let i = r; i < n; i++) {
      if (getBit(rows[i], c)) {
        sel = i;
        break;
      }
    }
    if (sel < 0) return null;
    if (sel !== r) {
      [rows[sel], rows[r]] = [rows[r], rows[sel]];
      [payloads[sel], payloads[r]] = [payloads[r], payloads[sel]];
    }
    for (let i = 0; i < n; i++) {
      if (i !== r && getBit(rows[i], c)) {
        xorRow(rows[i], rows[r]);
        xorBytes(payloads[i], payloads[r]);
      }
    }
    pivotRow[c] = r;
    r++;
  }
  if (r < cols) return null;
  const out = new Array(cols);
  for (let c = 0; c < cols; c++) out[c] = payloads[pivotRow[c]];
  return out;
}
