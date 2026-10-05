# lt-fountain-codes

LT fountain codes from scratch in plain JavaScript: robust soliton degree distribution, a linear time peeling decoder, an exact GF(2) maximum likelihood decoder, and a self describing packet format with CRC-32. Zero dependencies, Node 18+.

```
$ node bin/ltfc.js demo --loss 0.3
message 200000 B -> k=196 blocks; channel loss 30.00%
sent 268 packets (279.5 KiB), received 197, decoded with overhead 0.51% via ml
no retransmissions, no acknowledgements; output matches input
```

## The problem

You want to push a file to receivers over a channel that drops packets: UDP multicast, a satellite downlink, a radio link, a flaky mesh. TCP style retransmission needs a back channel and scales terribly to many receivers, each of which loses *different* packets.

A fountain code sidesteps all of that. The sender turns `k` source blocks into an effectively endless stream of encoded symbols. Any receiver that collects slightly more than `k` of them, **whichever ones**, in any order, rebuilds the file. Loss stops being an error and just becomes extra waiting time. No acknowledgements, no retransmission bookkeeping, no per receiver state at the sender.

LT codes (Luby, 2002) are the first practical rateless codes and the core of Raptor codes (RFC 5053 / RFC 6330), which ship in 3GPP MBMS and DVB. This repo implements them properly, measures how they actually behave, and shows where the textbook decoder leaves performance on the table.

## How it works

**Encoding.** Each symbol picks a degree `d` from the robust soliton distribution, picks `d` distinct source blocks, and XORs them. The degree and the neighbours come from a PRNG seeded by `(stream seed, symbol id)`, so the graph is never transmitted: a packet carries only its 32 bit id and the decoder rederives the same neighbours.

**Peeling (belief propagation).** A received symbol whose unknown neighbour set shrinks to one block *is* that block. Recovering it gets XORed out of every other symbol touching it, which may expose new degree one symbols (the "ripple"). Linear time, but it stalls if the ripple empties, even when the received symbols already contain enough information.

**Maximum likelihood.** Decoding is really solving `A x = y` over GF(2). In `ml` mode every symbol's coefficient row also goes into an incremental rank tracker (a reduced basis keyed by pivot column). The moment the rank reaches `k`, the message is determined, and we run Gauss Jordan elimination on *only the residual system the peeler could not finish*. Peeling does the bulk of the work cheaply; elimination closes the gap.

## Results

Reception overhead `e`, where the receiver needed `k(1 + e)` symbols. Default parameters `c = 0.03`, `delta = 0.5`, measured with `ltfc simulate` (every trial also verifies the decoded bytes):

| k | trials | peeling mean | peeling p95 | ML mean | ML p95 |
|---:|---:|---:|---:|---:|---:|
| 100 | 200 | 36.4% | 84.0% | 7.3% | 21.2% |
| 1000 | 100 | 12.0% | 21.7% | 0.68% | 1.5% |
| 4000 | 10 | 8.5% | 16.2% | 0.11% | 0.21% |

The same stream, decoded both ways, on a real file with 70 of 381 packets deleted and one corrupted:

```
$ node bin/ltfc.js decode pk/ out.bin --shuffle
skip pkt-0000000.ltp: checksum mismatch
recovered 300000 B from 300 packets (k=293, overhead 2.39%, 1 skipped, solved by ml)

$ node bin/ltfc.js decode pk/ out2.bin --mode peeling
skip pkt-0000000.ltp: checksum mismatch
could not decode: 310 useful packets, k=293. Collect a few more packets and retry.
```

`ltfc simulate` also prints an empirical failure curve, `P(decode fails | exactly k(1+e) symbols received)`, which is the number you actually size a broadcast carousel by.

## Usage

No install step. Clone and run:

```bash
npm test                                   # 36 tests, about a second
node bin/ltfc.js demo --size 1000000 --loss 0.5
node bin/ltfc.js simulate --k 1000 --trials 100

node bin/ltfc.js encode photo.jpg packets/ --block 1024 --overhead 0.3
# delete or corrupt a pile of packets/*.ltp, then:
node bin/ltfc.js decode packets/ photo-copy.jpg --shuffle
```

As a library:

```js
import { LTEncoder, LTDecoder, encodePacket, decodePacket } from './src/index.js';

const enc = new LTEncoder(bytes, { blockSize: 1024, seed: 42 });
const wire = encodePacket(enc.code, 7, enc.symbol(7).data);   // send this anywhere

const pkt = decodePacket(wire);                 // throws PacketError on corruption
const dec = new LTDecoder(pkt.params);          // mode: 'auto' | 'peeling' | 'ml'
if (dec.addSymbol(pkt.id, pkt.data)) console.log(dec.result(), dec.stats);
```

## Layout

```
src/prng.js       mix32, Mulberry32, Floyd's distinct sampling
src/soliton.js    ideal and robust soliton pmfs, inverse CDF sampler
src/code.js       the shared code description (graph is rederived, never sent)
src/encoder.js    rateless encoder, symbols are pure functions of id
src/decoder.js    peeling with the XOR of indices trick, residual ML solve
src/gf2.js        packed bitset rows, incremental rank tracker, Gauss Jordan
src/packet.js     44 byte self describing header, CRC-32
src/simulate.js   Monte Carlo overhead and failure curves
bin/ltfc.js       CLI: encode, decode, simulate, demo
```

## Design notes

* **Graph by seed, not by list.** Shipping neighbour lists would cost more than the payload at small block sizes. Instead both ends rebuild the graph from `(seed, id)` with fully specified integer mixers; `Math.random` never touches the codec. One subtle consequence: `c` and `delta` travel as float32, so the encoder rounds them to float32 too. Otherwise a receiver could build a pmf that differs in the last bit and silently disagree about degrees.
* **XOR of indices.** For each pending symbol the peeler stores its unknown degree and the XOR of its unknown neighbour indices. When the degree hits 1 that XOR *is* the remaining neighbour, so there are no per symbol sets to maintain.
* **Exact stopping point.** Rather than "try Gaussian elimination every N packets", the incremental rank tracker knows the precise symbol at which the system becomes solvable. That is what lets the simulator report true minimum overheads, and a test asserts it.
* **Payloads touched once.** The rank tracker only manipulates coefficient bits. Payload XORs happen in the peeler and in a single residual solve, never during rank tracking.
* **Auto mode.** Rank tracking is roughly quadratic in `k`, so `auto` uses ML up to `k = 4096` and pure peeling above that, where peeling's overhead is also smaller. For very large `k` the real answer is a precode (that is what Raptor adds); see below.
* **Corruption becomes erasure.** The CRC covers the header and payload, so a damaged packet is dropped and the code treats it like any lost one. A test flips every single bit of a packet and checks each flip is caught.

## Testing

`npm test` runs Node's built in test runner over 36 tests:

* PRNG determinism and a chi square uniformity check, unbiased Floyd sampling
* soliton pmfs sum to one, robust spike lands at `floor(k / R)`, sampler matches its pmf within 5 sigma
* rank tracker cross checked against brute force elimination on 60 random matrices, row by row
* CRC-32 check value `0xCBF43926`, round trip of every header field, all single bit flips detected
* round trips for awkward sizes (empty, one byte, exact multiples, prime lengths) in both modes, 50% loss with shuffled order, duplicates, wire format at 66% loss
* property test: on the same stream ML never needs more symbols than peeling, and never fewer than `k`

## Limitations and next steps

* To cover every block with high probability, plain LT codes need an average degree that grows like `ln k`, so encoding costs `O(ln k)` XORs per symbol. Raptor codes fix this with a high rate precode (LDPC plus HDPC) over the source blocks; that is the natural next layer on top of this decoder.
* The ML path stores a `k x k` bit basis, about 2 MB at `k = 4096`.
* Not systematic: the first `k` symbols are not the raw source blocks. RFC 5053 style systematic encoding would make zero loss receivers free.

## References

* M. Luby, *LT Codes*, FOCS 2002
* D. MacKay, *Fountain Codes*, IEE Proc. Communications, 2005 (source of the `c = 0.03, delta = 0.5` defaults)
* A. Shokrollahi, *Raptor Codes*, IEEE Trans. Information Theory, 2006

MIT licensed.
