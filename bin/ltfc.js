#!/usr/bin/env node
// ltfc: encode files into fountain packets, decode from any subset, and
// measure how many packets a receiver really needs.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LTDecoder,
  LTEncoder,
  PacketError,
  decodePacket,
  encodePacket,
  failureCurve,
  meanDegree,
  robustSoliton,
  runTrials,
  sameParams,
} from '../src/index.js';
import { mulberry32 } from '../src/prng.js';

const USAGE = `ltfc: LT fountain codes

  ltfc encode <file> <outdir> [--block 1024] [--overhead 0.25] [--seed N] [--c 0.03] [--delta 0.5]
      write ceil(k * (1 + overhead)) packets to outdir/pkt-<id>.ltp

  ltfc decode <indir> <outfile> [--mode auto|peeling|ml] [--shuffle]
      read packets until the file is recovered (corrupt or foreign ones are skipped)

  ltfc simulate [--k 1000] [--trials 40] [--mode ml|peeling|both] [--c 0.03] [--delta 0.5]
      Monte Carlo reception overhead, with a failure curve

  ltfc demo [--size 200000] [--block 1024] [--loss 0.3]
      encode random data, push it through a lossy channel, decode, verify
`;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opt[key] = true;
      else opt[key] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

const num = (v, d) => (v === undefined ? d : Number(v));
const pct = (x) => `${(x * 100).toFixed(2)}%`;

function encode([file, outdir], opt) {
  if (!file || !outdir) return fail(USAGE);
  const data = new Uint8Array(readFileSync(file));
  const enc = new LTEncoder(data, {
    blockSize: num(opt.block, 1024),
    seed: num(opt.seed, (Math.random() * 2 ** 32) >>> 0),
    c: num(opt.c, 0.03),
    delta: num(opt.delta, 0.5),
  });
  const count = Math.ceil(enc.k * (1 + num(opt.overhead, 0.25)));
  mkdirSync(outdir, { recursive: true });
  for (let id = 0; id < count; id++) {
    const s = enc.symbol(id);
    writeFileSync(join(outdir, `pkt-${String(id).padStart(7, '0')}.ltp`), encodePacket(enc.code, id, s.data));
  }
  console.log(`k=${enc.k} source blocks of ${enc.code.blockSize} B, wrote ${count} packets to ${outdir}`);
  console.log(`any ~${Math.max(0, count - Math.ceil(enc.k * 1.05))} of them can go missing and decoding will typically still succeed`);
}

function decode([indir, outfile], opt) {
  if (!indir || !outfile) return fail(USAGE);
  let files = readdirSync(indir).filter((f) => f.endsWith('.ltp'));
  if (opt.shuffle) files = shuffle(files, mulberry32(Date.now() >>> 0));
  let dec = null;
  let params = null;
  let skipped = 0;
  for (const f of files) {
    let pkt;
    try {
      pkt = decodePacket(new Uint8Array(readFileSync(join(indir, f))));
    } catch (e) {
      if (!(e instanceof PacketError)) throw e;
      skipped++;
      console.warn(`skip ${f}: ${e.message}`);
      continue;
    }
    if (!dec) {
      params = pkt.params;
      dec = new LTDecoder(params, { mode: opt.mode ?? 'auto' });
    } else if (!sameParams(params, pkt.params)) {
      skipped++;
      continue;
    }
    if (dec.addSymbol(pkt.id, pkt.data)) break;
  }
  if (!dec || !dec.complete) {
    const have = dec ? `${dec.received} useful packets, k=${dec.k}` : 'no valid packets';
    return fail(`could not decode: ${have}. Collect a few more packets and retry.`);
  }
  writeFileSync(outfile, dec.result());
  const s = dec.stats;
  console.log(`recovered ${params.length} B from ${s.received} packets (k=${s.k}, overhead ${pct(s.overhead)}, ${skipped} skipped, solved by ${s.solvedBy})`);
}

function simulate(_, opt) {
  const k = num(opt.k, 1000);
  const trials = num(opt.trials, 40);
  const c = num(opt.c, 0.03);
  const delta = num(opt.delta, 0.5);
  const dist = robustSoliton(k, c, delta);
  console.log(`k=${k}  c=${c}  delta=${delta}  R=${dist.R.toFixed(2)}  spike at d=${dist.spike}  mean degree=${meanDegree(dist.pmf).toFixed(2)}`);
  const modes = opt.mode === 'both' || opt.mode === undefined ? ['peeling', 'ml'] : [opt.mode];
  const eps = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3];
  for (const mode of modes) {
    const t0 = performance.now();
    const r = runTrials({ k, trials, c, delta, mode, blockSize: 4, verify: true });
    const ms = performance.now() - t0;
    console.log(`\n[${mode}] ${trials} trials in ${(ms / 1000).toFixed(2)} s`);
    console.log(`  overhead  mean ${pct(r.meanOverhead)}  p50 ${pct(r.p50)}  p95 ${pct(r.p95)}  min ${pct(r.min)}  max ${pct(r.max)}`);
    console.log('  P(fail | received k(1+e)):');
    for (const row of failureCurve(r.samples, k, eps)) {
      const bar = '#'.repeat(Math.round(row.failureRate * 40));
      console.log(`    e=${row.overhead.toFixed(2).padStart(4)}  ${row.failureRate.toFixed(3)}  ${bar}`);
    }
  }
}

function demo(_, opt) {
  const size = num(opt.size, 200000);
  const loss = num(opt.loss, 0.3);
  const data = new Uint8Array(randomBytes(size));
  const enc = new LTEncoder(data, { blockSize: num(opt.block, 1024), seed: 42 });
  const dec = new LTDecoder(enc.params);
  const rng = mulberry32(7);
  let sent = 0;
  let wire = 0;
  for (const sym of enc.symbols()) {
    sent++;
    const pkt = encodePacket(enc.code, sym.id, sym.data);
    wire += pkt.length;
    if (rng() < loss) continue; // erased in flight
    const got = decodePacket(pkt);
    if (dec.addSymbol(got.id, got.data)) break;
  }
  const out = dec.result();
  const ok = out.length === data.length && out.every((b, i) => b === data[i]);
  const s = dec.stats;
  console.log(`message ${size} B -> k=${s.k} blocks; channel loss ${pct(loss)}`);
  console.log(`sent ${sent} packets (${(wire / 1024).toFixed(1)} KiB), received ${s.received}, decoded with overhead ${pct(s.overhead)} via ${s.solvedBy}`);
  console.log(`no retransmissions, no acknowledgements; output ${ok ? 'matches' : 'DOES NOT match'} input`);
  if (!ok) process.exit(1);
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const { pos, opt } = parseArgs(process.argv.slice(2));
const commands = { encode, decode, simulate, demo };
const cmd = commands[pos[0]];
if (!cmd) fail(USAGE);
else cmd(pos.slice(1), opt);
