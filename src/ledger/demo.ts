/**
 * ledger/demo.ts — Slice 3 walkthrough: an encrypted, tamper-evident, anchored
 * registry. Mint and mark a copy, record it, prove the file is encrypted at
 * rest, reopen and verify the chain, catch tampering, and anchor the root.
 */

import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { SecureRegistry, localAttestationAnchor } from './index.js';
import { mark } from '../orchestrator.js';
import { newCopyIdentity, hmacIssuer, deriveEd25519 } from '../crypto.js';
import { sha256, ProtectedCopy } from '../registry.js';
import { Scheme } from '../frame.js';

function line(s = '') {
  console.log(s);
}
function rule(title: string) {
  line();
  line('='.repeat(78));
  line(title);
  line('='.repeat(78));
}

const path = join(tmpdir(), 'markityours-demo-' + randomBytes(6).toString('hex') + '.reg');
const passphrase = 'demo-passphrase-do-not-use-in-production';
const orgKey = randomBytes(32);

const MEMO =
  'PRIVILEGED AND CONFIDENTIAL. This memorandum sets out the settlement posture ' +
  'and the discovery obligations of the parties under the applicable rules of ' +
  'procedure, and it must not circulate outside the steering committee.';

try {
  rule('1. CREATE AN ENCRYPTED REGISTRY AND RECORD A MARKED COPY');
  const reg = SecureRegistry.create(path, passphrase);

  const issuer = hmacIssuer(orgKey, (h) => reg.has(h));
  const identity = newCopyIdentity('MATTER-2026-0417', 'opposing.counsel@example.com', 'v3');
  const marked = mark(MEMO, identity, issuer, { codecs: ['WS', 'ZW', 'HG'] });

  const copy: ProtectedCopy = {
    tokenHex: marked.tokenHex,
    shortIdHex: marked.shortIdHex,
    scheme: Scheme.HMAC_SHA256,
    identity,
    originalHash: sha256(MEMO),
    protectedHash: sha256(marked.text),
    generatedBy: 'zbrenner',
    generatedAt: identity.issuedAt,
    channels: marked.layers,
    deliveryMethod: 'email',
    transformTests: [],
    investigations: [],
  };
  reg.add(copy);
  reg.recordInvestigation(marked.tokenHex, {
    at: new Date().toISOString(),
    actor: 'zbrenner',
    kind: 'detection',
    detail: 'Recovered from a third-party disclosure',
    survivingChannels: ['HG'],
  });
  line(`  recipient   : ${identity.recipientId}`);
  line(`  token       : ${marked.tokenHex.slice(0, 24)}...`);
  line(`  events       : ${reg.eventCount()} (1 copy + 1 investigation)`);
  line(`  chain intact : ${reg.verify()}`);
  line(`  chain head   : ${reg.head().slice(0, 24)}...`);

  rule('2. ENCRYPTION AT REST');
  const raw = readFileSync(path);
  line(`  file size            : ${raw.length} bytes`);
  line(`  AES-256-GCM + scrypt : magic "MIYLv1" | salt | iv | tag | ciphertext`);
  line(`  recipient in plaintext? : ${raw.toString('latin1').includes(identity.recipientId)}`);
  line(`  token in plaintext?     : ${raw.toString('latin1').includes(marked.tokenHex)}`);

  rule('3. REOPEN: DECRYPT + VERIFY CHAIN + RESOLVE');
  const reopened = SecureRegistry.open(path, passphrase);
  line(`  chain verified on open : ${reopened.verify()}`);
  const hit = reopened.resolve(marked.tokenHex);
  line(`  resolve(token)         : ${hit?.identity.recipientId} / ${hit?.identity.matterRef}`);
  line(`  resolve(short-id)      : ${reopened.resolve(marked.shortIdHex)?.identity.recipientId}`);
  line(`  investigations replayed: ${reopened.resolve(marked.tokenHex)?.investigations.length}`);

  rule('4. TAMPER-EVIDENCE');
  try {
    SecureRegistry.open(path, 'the-wrong-passphrase');
  } catch (e) {
    line(`  wrong passphrase       : rejected (${(e as Error).message})`);
  }
  const tampered = Buffer.from(raw);
  tampered[tampered.length - 3] ^= 0x01;
  const tpath = path + '.tampered';
  writeFileSync(tpath, tampered);
  try {
    SecureRegistry.open(tpath, passphrase);
  } catch (e) {
    line(`  flipped ciphertext bit : rejected (${(e as Error).message})`);
  }
  rmSync(tpath, { force: true });
  line('  (the hash chain also catches an insider who edits a row and re-encrypts:');
  line('   recomputing the chain no longer reproduces the stored head.)');

  rule('5. ANCHOR THE MERKLE ROOT');
  const kp = deriveEd25519(orgKey);
  const anchor = localAttestationAnchor(kp);
  const checkpoint = reopened.anchorCheckpoint(anchor);
  line(`  checkpoint   : ${checkpoint.format}`);
  line(`  event prefix : ${checkpoint.eventCount}`);
  line(`  merkle root  : ${checkpoint.root.slice(0, 24)}...`);
  line(`  anchor       : ${anchor.name} (third-party time: ${anchor.thirdPartyTime})`);
  line(`  proof valid  : ${reopened.verifyAnchorCheckpoint(anchor, checkpoint)}`);
  line();
  line('  HONEST LIMIT: the local attestation is non-repudiable as to the org, but');
  line('  its timestamp is self-asserted. For independently provable priority, use');
  line('  openTimestampsCliAnchor(): retain the full checkpoint and pending .ots');
  line('  proof, then refresh and verify after the Bitcoin attestation confirms.');
  line();
} finally {
  rmSync(path, { force: true });
}
