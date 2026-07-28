/**
 * ots.ts — OpenTimestamps proof serialization, model, and offline verification.
 *
 * This is the pure, I/O-free core of the OpenTimestamps anchor. It implements
 * the real `.ots` wire format (github.com/opentimestamps/python-opentimestamps),
 * so a proof we produce is a standard DetachedTimestampFile that ANY OpenTimestamps
 * tool can read, upgrade, and verify against Bitcoin. That interoperability is the
 * whole point: it is what makes "this Merkle root predates block N" provable to a
 * skeptic who trusts Bitcoin, not us.
 *
 * A timestamp is a tree. It starts from a message (our 32-byte ledger Merkle
 * root) and applies operations — append/prepend bytes, then a hash — until it
 * reaches an ATTESTATION: either a PENDING promise from a calendar server, or a
 * BITCOIN block-header commitment (the message at that node equals the merkle
 * root of the block at the stated height).
 *
 * Honest scope of the OFFLINE verifier here:
 *   - It parses the proof, replays every operation, and reports each attestation
 *     with the exact commitment the message reduces to.
 *   - It confirms the proof actually commits to the digest you claim.
 *   - It CANNOT, on its own, prove a Bitcoin attestation is real: that requires
 *     the merkle root of the block at the stated height, which lives in the
 *     Bitcoin chain. We surface (height, commitment) so an external block-header
 *     source can finish the proof, and never pretend to have done so ourselves.
 *
 * Supported operations: append (0xf0), prepend (0xf1), sha256 (0x08),
 * ripemd160 (0x03), sha1 (0x02). Real calendar→Bitcoin proofs use exactly this
 * set. Any other op tag is rejected at parse time rather than mis-decoded
 * (an unknown op has an unknown argument length — guessing would corrupt the
 * tree silently, which this repo does not do).
 */

import { createHash } from 'node:crypto';

/* ------------------------------ wire primitives ---------------------------- */

/** DetachedTimestampFile header magic (fixed byte string). */
export const HEADER_MAGIC = Buffer.from(
  '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294',
  'hex',
);
export const MAJOR_VERSION = 1;
const MAX_ATTESTATION_PAYLOAD = 8192;

const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
const OP_SHA1 = 0x02;
const OP_RIPEMD160 = 0x03;
const OP_SHA256 = 0x08;

const PENDING_TAG = Buffer.from('83dfe30d2ef90c8e', 'hex');
const BITCOIN_TAG = Buffer.from('0588960d73d71901', 'hex');

class Writer {
  private chunks: Buffer[] = [];
  byte(b: number): void {
    this.chunks.push(Buffer.from([b & 0xff]));
  }
  bytes(b: Buffer): void {
    this.chunks.push(b);
  }
  /** OTS varuint: little-endian base-128, high bit = "more bytes follow". */
  varuint(nRaw: number): void {
    let n = nRaw;
    if (n === 0) {
      this.byte(0);
      return;
    }
    while (n !== 0) {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n !== 0) b |= 0x80;
      this.byte(b);
    }
  }
  varbytes(b: Buffer): void {
    this.varuint(b.length);
    this.bytes(b);
  }
  concat(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  constructor(
    private readonly buf: Buffer,
    private pos = 0,
  ) {}
  get offset(): number {
    return this.pos;
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('ots: unexpected end of proof');
    return this.buf[this.pos++];
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('ots: unexpected end of proof');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varuint(): number {
    let value = 0;
    let shift = 1;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) break;
      shift *= 128;
      if (shift > Number.MAX_SAFE_INTEGER) throw new Error('ots: varuint overflow');
    }
    return value;
  }
  varbytes(): Buffer {
    return this.bytes(this.varuint());
  }
  expect(magic: Buffer, what: string): void {
    const got = this.bytes(magic.length);
    if (!got.equals(magic)) throw new Error(`ots: bad ${what}`);
  }
}

/* --------------------------------- model ----------------------------------- */

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: string; payload: string };

export interface OpStep {
  op: number;
  /** argument bytes for append/prepend; absent for unary hash ops */
  arg?: Buffer;
  next: Timestamp;
}

/** A node in the timestamp tree. `msg` is the running message at this node. */
export interface Timestamp {
  msg: Buffer;
  attestations: Attestation[];
  ops: OpStep[];
}

export interface DetachedTimestamp {
  fileHashOp: number;
  fileDigest: Buffer;
  timestamp: Timestamp;
}

function hash(alg: 'sha256' | 'ripemd160' | 'sha1', msg: Buffer): Buffer {
  return createHash(alg).update(msg).digest();
}

/** Apply one operation to a message, yielding the child node's message. */
export function applyOp(op: number, arg: Buffer | undefined, msg: Buffer): Buffer {
  switch (op) {
    case OP_APPEND:
      return Buffer.concat([msg, arg ?? Buffer.alloc(0)]);
    case OP_PREPEND:
      return Buffer.concat([arg ?? Buffer.alloc(0), msg]);
    case OP_SHA256:
      return hash('sha256', msg);
    case OP_RIPEMD160:
      return hash('ripemd160', msg);
    case OP_SHA1:
      return hash('sha1', msg);
    default:
      throw new Error(`ots: unsupported operation 0x${op.toString(16)}`);
  }
}

export function opName(op: number): string {
  return (
    {
      [OP_APPEND]: 'append',
      [OP_PREPEND]: 'prepend',
      [OP_SHA256]: 'sha256',
      [OP_RIPEMD160]: 'ripemd160',
      [OP_SHA1]: 'sha1',
    }[op] ?? `op0x${op.toString(16)}`
  );
}

/* ------------------------------ (de)serialize ------------------------------ */

function writeAttestation(w: Writer, a: Attestation): void {
  const payload = new Writer();
  let tag: Buffer;
  if (a.kind === 'pending') {
    tag = PENDING_TAG;
    payload.varbytes(Buffer.from(a.uri, 'utf8'));
  } else if (a.kind === 'bitcoin') {
    tag = BITCOIN_TAG;
    payload.varuint(a.height);
  } else {
    tag = Buffer.from(a.tag, 'hex');
    payload.bytes(Buffer.from(a.payload, 'hex'));
  }
  w.bytes(tag);
  w.varbytes(payload.concat());
}

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8);
  const payload = r.varbytes();
  if (payload.length > MAX_ATTESTATION_PAYLOAD) throw new Error('ots: attestation payload too large');
  const pr = new Reader(payload);
  if (tag.equals(PENDING_TAG)) {
    return { kind: 'pending', uri: pr.varbytes().toString('utf8') };
  }
  if (tag.equals(BITCOIN_TAG)) {
    return { kind: 'bitcoin', height: pr.varuint() };
  }
  return { kind: 'unknown', tag: tag.toString('hex'), payload: payload.toString('hex') };
}

/**
 * Serialize a timestamp. Elements (attestations then ops) are emitted in stored
 * order; every element except the last is prefixed with 0xff, exactly mirroring
 * the deserializer's `while tag == 0xff` loop, so bytes round-trip identically.
 */
function writeTimestamp(w: Writer, t: Timestamp): void {
  const elements: Array<{ att?: Attestation; step?: OpStep }> = [
    ...t.attestations.map((att) => ({ att })),
    ...t.ops.map((step) => ({ step })),
  ];
  if (elements.length === 0) throw new Error('ots: timestamp node has no attestations or ops');
  elements.forEach((el, i) => {
    if (i < elements.length - 1) w.byte(0xff);
    if (el.att) {
      w.byte(0x00);
      writeAttestation(w, el.att);
    } else {
      const step = el.step!;
      w.byte(step.op);
      if (step.op === OP_APPEND || step.op === OP_PREPEND) w.varbytes(step.arg ?? Buffer.alloc(0));
      writeTimestamp(w, step.next);
    }
  });
}

function readTimestamp(r: Reader, msg: Buffer): Timestamp {
  const t: Timestamp = { msg, attestations: [], ops: [] };
  const handle = (tagByte: number): void => {
    if (tagByte === 0x00) {
      t.attestations.push(readAttestation(r));
      return;
    }
    let arg: Buffer | undefined;
    if (tagByte === OP_APPEND || tagByte === OP_PREPEND) arg = r.varbytes();
    const childMsg = applyOp(tagByte, arg, msg);
    t.ops.push({ op: tagByte, arg, next: readTimestamp(r, childMsg) });
  };
  let tag = r.byte();
  while (tag === 0xff) {
    handle(r.byte());
    tag = r.byte();
  }
  handle(tag);
  return t;
}

/** Serialize just a Timestamp subtree (calendar responses are in this form). */
export function serializeTimestamp(t: Timestamp): Buffer {
  const w = new Writer();
  writeTimestamp(w, t);
  return w.concat();
}

export function deserializeTimestamp(bytes: Buffer, msg: Buffer): Timestamp {
  return readTimestamp(new Reader(bytes), msg);
}

/** Serialize a full DetachedTimestampFile (`.ots` file bytes). */
export function serializeDetached(d: DetachedTimestamp): Buffer {
  const w = new Writer();
  w.bytes(HEADER_MAGIC);
  w.varuint(MAJOR_VERSION);
  w.byte(d.fileHashOp);
  w.bytes(d.fileDigest);
  writeTimestamp(w, d.timestamp);
  return w.concat();
}

export function deserializeDetached(bytes: Buffer): DetachedTimestamp {
  const r = new Reader(bytes);
  r.expect(HEADER_MAGIC, 'file header magic');
  const version = r.varuint();
  if (version !== MAJOR_VERSION) throw new Error(`ots: unsupported major version ${version}`);
  const fileHashOp = r.byte();
  // SHA-1 and RIPEMD-160 digests are 20 bytes; SHA-256 is 32.
  const digestLen = fileHashOp === OP_SHA1 || fileHashOp === OP_RIPEMD160 ? 20 : 32;
  const fileDigest = r.bytes(digestLen);
  const timestamp = readTimestamp(r, fileDigest);
  return { fileHashOp, fileDigest, timestamp };
}

/* -------------------------------- verify ----------------------------------- */

export interface ReachedAttestation {
  attestation: Attestation;
  /** the message the tree reduces to at this attestation, hex-encoded */
  commitment: string;
}

/** Walk the tree, applying ops, and collect every attestation with its commitment. */
export function walkAttestations(t: Timestamp): ReachedAttestation[] {
  const out: ReachedAttestation[] = [];
  for (const a of t.attestations) out.push({ attestation: a, commitment: t.msg.toString('hex') });
  for (const step of t.ops) out.push(...walkAttestations(step.next));
  return out;
}

export interface OtsSummary {
  digestHex: string;
  pending: Array<{ uri: string; commitment: string }>;
  bitcoin: Array<{ height: number; commitment: string }>;
  unknown: number;
  /** true once at least one Bitcoin attestation is present (upgraded proof) */
  confirmed: boolean;
}

/** Structural summary of a detached proof: what it commits to and how far. */
export function summarize(d: DetachedTimestamp): OtsSummary {
  const reached = walkAttestations(d.timestamp);
  const pending: OtsSummary['pending'] = [];
  const bitcoin: OtsSummary['bitcoin'] = [];
  let unknown = 0;
  for (const r of reached) {
    if (r.attestation.kind === 'pending') pending.push({ uri: r.attestation.uri, commitment: r.commitment });
    else if (r.attestation.kind === 'bitcoin') bitcoin.push({ height: r.attestation.height, commitment: r.commitment });
    else unknown++;
  }
  return {
    digestHex: d.fileDigest.toString('hex'),
    pending,
    bitcoin,
    unknown,
    confirmed: bitcoin.length > 0,
  };
}

/**
 * Optional final step: confirm each Bitcoin attestation against a block-header
 * source the caller trusts. `merkleRootOf(height)` returns the block's merkle
 * root (hex) or null if unknown. A Bitcoin attestation verifies iff that root
 * equals the commitment the proof reduces to at that node. Returns per-height
 * results; callers decide how much confirmation they require.
 */
export async function confirmBitcoin(
  d: DetachedTimestamp,
  merkleRootOf: (height: number) => Promise<string | null>,
): Promise<Array<{ height: number; commitment: string; ok: boolean }>> {
  const out: Array<{ height: number; commitment: string; ok: boolean }> = [];
  for (const b of summarize(d).bitcoin) {
    const root = await merkleRootOf(b.height);
    out.push({ height: b.height, commitment: b.commitment, ok: root !== null && root.toLowerCase() === b.commitment.toLowerCase() });
  }
  return out;
}

/* --------------------------- construction helpers -------------------------- */

/** A leaf detached proof: the digest, stamped only by the given attestations. */
export function detachedFromAttestations(digest: Buffer, attestations: Attestation[]): DetachedTimestamp {
  return { fileHashOp: OP_SHA256, fileDigest: digest, timestamp: { msg: digest, attestations, ops: [] } };
}

/**
 * Splice an upgrade into a proof: wherever a pending attestation's commitment
 * matches `commitment`, add the fetched sub-timestamp's ops/attestations to that
 * node. Used when a calendar returns a Bitcoin-attested extension of a pending
 * commitment. Returns a new tree; the input is not mutated.
 */
export function spliceUpgrade(t: Timestamp, commitment: string, upgrade: Timestamp): Timestamp {
  const here = t.msg.toString('hex') === commitment;
  const merged: Timestamp = {
    msg: t.msg,
    attestations: [...t.attestations],
    ops: t.ops.map((s) => ({ op: s.op, arg: s.arg, next: spliceUpgrade(s.next, commitment, upgrade) })),
  };
  if (here) {
    for (const a of upgrade.attestations) merged.attestations.push(a);
    for (const s of upgrade.ops) merged.ops.push(s);
  }
  return merged;
}

/** Merge two timestamps that share the same root message (multi-calendar stamp). */
export function mergeTimestamps(a: Timestamp, b: Timestamp): Timestamp {
  if (a.msg.toString('hex') !== b.msg.toString('hex')) {
    throw new Error('ots: cannot merge timestamps with different root messages');
  }
  return {
    msg: a.msg,
    attestations: [...a.attestations, ...b.attestations],
    ops: [...a.ops, ...b.ops],
  };
}
