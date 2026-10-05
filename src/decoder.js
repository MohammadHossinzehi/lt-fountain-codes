// LT decoder: belief propagation (peeling) with an exact GF(2) fallback.
//
// Peeling. A symbol whose unknown neighbour set has shrunk to one block IS
// that block. Recovering it lets us XOR it out of every other symbol that
// touched it, which may expose new degree one symbols (the "ripple").
// Linear time, but it stalls if the ripple empties, even when the received
// symbols contain enough information.
//
// Maximum likelihood. In "ml" mode we also feed every symbol's coefficient
// row into an incremental GF(2) rank tracker. The instant the rank reaches
// k, the message is determined; we then run Gauss Jordan elimination on just
// the residual system the peeler could not finish (usually a small fraction
// of k). This typically cuts reception overhead several fold at small k.
//
// Bookkeeping trick: for each pending symbol we keep its unknown degree and
// the XOR of its unknown neighbour indices. When the degree hits 1, that XOR
// *is* the last neighbour, so no per symbol sets are needed.

import { copyBytes, xorInto } from './bytes.js';
import { LTCode } from './code.js';
import { RankTracker, newRow, setBit, solve } from './gf2.js';

export const ML_AUTO_LIMIT = 4096;

export class LTDecoder {
  /**
   * @param {object} params  { length, blockSize, seed, c, delta }
   * @param {object} [opts]  { mode: 'auto' | 'peeling' | 'ml' }
   */
  constructor(params, { mode = 'auto' } = {}) {
    this.code = new LTCode(params);
    const k = this.code.k;
    if (mode === 'auto') mode = k <= ML_AUTO_LIMIT ? 'ml' : 'peeling';
    if (mode !== 'peeling' && mode !== 'ml') throw new RangeError(`unknown mode ${mode}`);
    this.mode = mode;

    this.blocks = new Array(k).fill(null);
    this.recovered = new Uint8Array(k);
    this.recoveredCount = 0;
    this.adj = Array.from({ length: k }, () => []);

    this.symData = [];
    this.symNbrs = [];
    this.symDeg = [];
    this.symIdx = [];
    this.ripple = [];
    this.seen = new Set();
    this.tracker = mode === 'ml' ? new RankTracker(k) : null;

    this.received = 0;
    this.duplicates = 0;
    this.redundant = 0;
    this.solvedBy = null;
  }

  get k() {
    return this.code.k;
  }

  get complete() {
    return this.recoveredCount === this.code.k;
  }

  /**
   * Feed one encoded symbol. Duplicates are ignored. Returns true once the
   * whole message is recovered.
   */
  addSymbol(id, data) {
    if (this.complete) return true;
    id >>>= 0;
    if (data.length !== this.code.blockSize) throw new RangeError('symbol has wrong block size');
    if (this.seen.has(id)) {
      this.duplicates++;
      return false;
    }
    this.seen.add(id);
    this.received++;

    const nbrs = this.code.neighbors(id);
    if (this.tracker) this.tracker.insertIndices(nbrs);

    const buf = copyBytes(data);
    let deg = 0;
    let idx = 0;
    for (const n of nbrs) {
      if (this.recovered[n]) xorInto(buf, this.blocks[n]);
      else {
        deg++;
        idx ^= n;
      }
    }

    if (deg === 0) {
      this.redundant++;
    } else {
      const s = this.symData.length;
      this.symData.push(buf);
      this.symNbrs.push(nbrs);
      this.symDeg.push(deg);
      this.symIdx.push(idx);
      for (const n of nbrs) if (!this.recovered[n]) this.adj[n].push(s);
      if (deg === 1) {
        this.ripple.push(s);
        this._peel();
      }
    }

    if (this.complete) this.solvedBy ??= 'peeling';
    else if (this.tracker && this.tracker.full) this._solveResidual();
    return this.complete;
  }

  _peel() {
    const { ripple, symDeg, symIdx, symData } = this;
    while (ripple.length > 0) {
      const s = ripple.pop();
      if (symDeg[s] !== 1) continue; // already consumed or reduced to zero
      const b = symIdx[s];
      symDeg[s] = -1;
      const buf = symData[s];
      symData[s] = null;
      if (!this.recovered[b]) this._recover(b, buf);
    }
  }

  _recover(b, buf) {
    this.blocks[b] = buf;
    this.recovered[b] = 1;
    this.recoveredCount++;
    const { symDeg, symIdx, symData, ripple } = this;
    for (const s of this.adj[b]) {
      if (symDeg[s] <= 0) continue;
      xorInto(symData[s], buf);
      symIdx[s] ^= b;
      if (--symDeg[s] === 1) ripple.push(s);
      else if (symDeg[s] === 0) {
        symDeg[s] = -1;
        symData[s] = null;
        this.redundant++;
      }
    }
    this.adj[b] = null;
  }

  _solveResidual() {
    const k = this.code.k;
    const unknown = [];
    const col = new Int32Array(k).fill(-1);
    for (let i = 0; i < k; i++) {
      if (!this.recovered[i]) {
        col[i] = unknown.length;
        unknown.push(i);
      }
    }
    const u = unknown.length;
    const rows = [];
    const payloads = [];
    for (let s = 0; s < this.symDeg.length; s++) {
      if (this.symDeg[s] < 2) continue;
      const row = newRow(u);
      for (const n of this.symNbrs[s]) if (col[n] >= 0) setBit(row, col[n]);
      rows.push(row);
      payloads.push(this.symData[s]);
    }
    const sol = solve(rows, payloads, u, xorInto);
    if (sol === null) throw new Error('internal: rank tracker reported full rank but residual system is singular');
    for (let c = 0; c < u; c++) {
      this.blocks[unknown[c]] = sol[c];
      this.recovered[unknown[c]] = 1;
    }
    this.recoveredCount = k;
    this.solvedBy = 'ml';
    this.residualSize = u;
    this.ripple.length = 0;
    this.symData = [];
    this.adj = [];
  }

  /** Recovered message bytes. Throws if decoding is not finished. */
  result() {
    if (!this.complete) throw new Error('decoding not complete');
    const { length, blockSize } = this.code;
    const out = new Uint8Array(length);
    for (let i = 0, off = 0; off < length; i++, off += blockSize) {
      out.set(this.blocks[i].subarray(0, Math.min(blockSize, length - off)), off);
    }
    return out;
  }

  get stats() {
    return {
      k: this.code.k,
      mode: this.mode,
      received: this.received,
      duplicates: this.duplicates,
      redundant: this.redundant,
      recovered: this.recoveredCount,
      rank: this.tracker ? this.tracker.rank : null,
      ripple: this.ripple.length,
      solvedBy: this.solvedBy,
      residualSize: this.residualSize ?? 0,
      overhead: this.complete ? (this.received - this.code.k) / this.code.k : null,
    };
  }
}
