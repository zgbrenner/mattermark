/**
 * demo.ts — end-to-end walk-through: mark -> register -> leak -> attribute.
 */

import { randomBytes } from 'node:crypto';
import { mark, detect } from './orchestrator.js';
import { newCopyIdentity, hmacIssuer, ed25519Issuer, deriveEd25519 } from './crypto.js';
import { Registry, sha256, ProtectedCopy } from './registry.js';
import { CHAINS, applyChain, excerpt } from './transforms.js';
import { runMatrix, capacityReport } from './harness.js';
import { Scheme } from './frame.js';

const MEMO = `PRIVILEGED AND CONFIDENTIAL - ATTORNEY WORK PRODUCT

MEMORANDUM

TO:      Steering Committee
FROM:    Litigation Counsel
RE:      Exposure analysis and settlement posture, Matter 2026-0417
DATE:    July 23, 2026

I. Summary

Our current exposure estimate assumes the plaintiff class is certified on the
narrower theory only. If the broader theory survives the motion to dismiss, the
damages model changes materially and the reserve should be revisited before the
next quarterly close. Counsel recommends preserving optionality on settlement
until the certification ruling issues.

II. Discovery posture

The document production has been substantially completed. Two custodians remain
outstanding pending a privilege review of their personal devices. We expect the
privilege log to be served within fourteen days. Opposing counsel has signaled
an intent to move to compel on the custodial gap, and we should be prepared to
oppose on proportionality grounds under Rule 26(b)(1).

III. Settlement posture

We assess the realistic settlement band as materially below the plaintiff's
stated demand. The mediator has proposed a further session following the
certification ruling. Our recommendation is to attend but to avoid signaling a
number before the ruling issues, since the certification outcome is the single
largest driver of valuation in this matter.

IV. Recommendation

Maintain the current reserve. Revisit within ten days of the certification
ruling. Do not circulate this memorandum outside the steering committee.`;

function line(s = '') {
  console.log(s);
}
function rule(title: string) {
  line();
  line('='.repeat(78));
  line(title);
  line('='.repeat(78));
}

/* ------------------------------------------------------------------ */

rule('1. CAPACITY OF THE SOURCE DOCUMENT');
line(`  document length: ${MEMO.length} chars`);
line(`  ${capacityReport(MEMO)}`);
line();
line('  Frame overhead: 6 B header. HMAC frame = 22 B. Ed25519 frame = 74 B.');

/* ------------------------------------------------------------------ */

rule('2. MARKING A RECIPIENT COPY (Ed25519, WS+ZW+HG)');

const orgKey = randomBytes(32);
const kp = deriveEd25519(orgKey);
const registry = new Registry();

const issuer = ed25519Issuer(kp, orgKey);
const identity = newCopyIdentity('MATTER-2026-0417', 'j.rivera@opposingfirm.example', 'v3');
const result = mark(MEMO, identity, issuer, { codecs: ['WS', 'ZW', 'HG'] });

line(`  recipient : ${identity.recipientId}`);
line(`  matter    : ${identity.matterRef} (${identity.version})`);
line(`  token     : ${result.tokenHex.slice(0, 32)}... (${result.tokenHex.length / 2} bytes, Ed25519)`);
line(`  short id  : ${result.shortIdHex} (12 bytes, registry pointer)`);
line(`  durable   : ${result.durable}`);
line();
for (const l of result.layers) {
  line(
    `  ${l.codec}  capacity=${String(l.capacityDigits).padStart(5)} digits  ` +
      `need=${String(l.requiredDigits).padStart(4)}  ` +
      (l.embedded
        ? `EMBEDDED ${l.payload!.toUpperCase().padEnd(5)} x${l.copiesEmbedded.toFixed(1)} copies`
        : `SKIPPED (${l.reason})`),
  );
}
line();
if (result.warnings.length) {
  line('  WARNINGS:');
  for (const w of result.warnings) line('    ! ' + w.replace(/\s+/g, ' '));
  line();
}
line(`  visible length delta: ${result.text.length - MEMO.length} chars ` +
     `(all zero-width; rendered text is unchanged)`);
line(`  original hash : ${sha256(MEMO).slice(0, 16)}...`);
line(`  protected hash: ${sha256(result.text).slice(0, 16)}...`);

const row: ProtectedCopy = {
  tokenHex: result.tokenHex,
  shortIdHex: result.shortIdHex,
  scheme: Scheme.ED25519,
  identity,
  originalHash: sha256(MEMO),
  protectedHash: sha256(result.text),
  generatedBy: 'zbrenner',
  generatedAt: new Date().toISOString(),
  channels: result.layers,
  deliveryMethod: 'email',
  transformTests: [],
  investigations: [],
};

/* ------------------------------------------------------------------ */

rule('3. SURVIVAL AGAINST THE TRANSPORT-TRANSFORM TAXONOMY');
line('  chain            recovered  surviving channels');
line('  ' + '-'.repeat(60));
for (const chain of CHAINS) {
  const transformed = applyChain(chain, result.text);
  const det = detect(transformed);
  const hit = det.tokens.find(
    (t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex,
  );
  row.transformTests.push({
    chain: chain.name,
    recovered: Boolean(hit),
    survivingChannels: hit?.channels ?? [],
  });
  line(
    `  ${chain.name.padEnd(16)} ${(hit ? 'YES' : 'no ').padEnd(10)} ` +
      `${hit ? hit.channels.join(', ') : '-'}`,
  );
}
line();
line('  T12 (LLM paraphrase, Tier 4): NOT MEASURED — requires a model. Assume');
line('  total loss of all symbolic channels. Only a linguistic layer addresses it.');

/* ------------------------------------------------------------------ */

rule('4. EXCERPT RESILIENCE (the actual legal leak shape)');
for (const f of [0.5, 0.3, 0.2, 0.1, 0.05]) {
  const piece = excerpt(result.text, f);
  const det = detect(piece);
  const hit = det.tokens.some(
    (t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex,
  );
  line(
    `  ${String(Math.round(f * 100)).padStart(3)}% excerpt (${String(piece.length).padStart(4)} chars): ` +
      `${hit ? 'ATTRIBUTED' : 'no recovery'}`,
  );
}

/* ------------------------------------------------------------------ */

rule('5. ATTRIBUTION FROM A RECOVERED LEAK');
registry.add(row);

const leaked = applyChain(CHAINS[4], excerpt(result.text, 0.5)); // Tier-1+2 on half the doc
const det = detect(leaked);

line(`  leaked artifact: ${leaked.length} chars, Tier-1+2 processed, 50% excerpt`);
line(`  frames recovered: ${det.channels.map((c) => `${c.codec}=${c.framesFound}`).join(' ')}`);
line();

for (const t of det.tokens) {
  const cryptoOk = t.short ? null : issuer.verify(Buffer.from(t.tokenHex, 'hex'));
  const hit = registry.resolve(t.tokenHex);
  line(`  ${t.short ? 'short-id' : 'token'} ${t.tokenHex.slice(0, 24)}...`);
  line(
    `    signature valid : ${cryptoOk === null ? 'n/a (registry pointer, not self-verifying)' : cryptoOk}`,
  );
  line(`    channels        : ${t.channels.join(', ')} (${t.frames} frames)`);
  if (hit) {
    line(`    RECIPIENT       : ${hit.identity.recipientId}`);
    line(`    matter          : ${hit.identity.matterRef} ${hit.identity.version}`);
    line(`    issued          : ${hit.identity.issuedAt}`);
    line(`    delivered via   : ${hit.deliveryMethod}`);
    line(`    original hash   : ${hit.originalHash.slice(0, 16)}...`);
    registry.recordInvestigation(hit.tokenHex, {
      at: new Date().toISOString(),
      actor: 'zbrenner',
      kind: 'detection',
      detail: 'Recovered from third-party disclosure',
      survivingChannels: t.channels,
      sourceDescription: 'Excerpt posted to public forum',
    });
  } else {
    line('    NOT IN REGISTRY — valid signature, unknown copy');
  }
}
line();
line(`  investigation events logged: ${registry.resolve(result.tokenHex)!.investigations.length}`);

/* ------------------------------------------------------------------ */

rule('6. COMPOSITION GUARD (the 97% -> 0% failure the paper found)');
for (const bad of [['WS'], ['ZW'], ['WS', 'ZW']] as Array<Array<'WS' | 'ZW' | 'HG'>>) {
  try {
    mark(MEMO, identity, issuer, { codecs: bad });
    line(`  ${bad.join('+').padEnd(8)} accepted`);
  } catch (e) {
    line(`  ${bad.join('+').padEnd(8)} REJECTED — ${(e as Error).message}`);
  }
}
line(`  ${'WS+ZW+HG'.padEnd(8)} accepted`);
line();
line('  The homoglyph channel is an OPTION, not a mandate. HG carries durability');
line('  but breaks exact-match / e-discovery search, which can be disqualifying for');
line('  litigators. An operator may deliberately drop it for a search-preserving');
line('  mark by acknowledging the trade with allowNonDurable:');
{
  const safe = mark(MEMO, identity, issuer, { codecs: ['WS', 'ZW'], allowNonDurable: true });
  line(`  ${'WS+ZW'.padEnd(8)} accepted with allowNonDurable  ` +
       `(durable=${safe.durable}, search-preserving: no homoglyph substitution)`);
  for (const w of safe.warnings) line('    ! ' + w.replace(/\s+/g, ' '));
}

/* ------------------------------------------------------------------ */

rule('7. FULL SURVIVAL MATRIX (both schemes, all stacks, two doc sizes)');
const rows = runMatrix(
  [
    { label: 'memo(1.6k)', text: MEMO },
    { label: 'short(280)', text: MEMO.slice(0, 280) },
  ],
  [['HG'], ['ZW', 'HG'], ['WS', 'ZW', 'HG']],
);

const header = ['scheme', 'stack', 'doc', 'T0', 'T1', 'T2', 'T3', 'T1+2', 'T1+2+3', 'T11', 'ex50', 'ex20'];
line('  ' + header.map((h, i) => h.padEnd(i < 3 ? [12, 9, 11][i] : 7)).join(''));
line('  ' + '-'.repeat(110));
for (const r of rows) {
  if (r.cells.length === 0) {
    line(`  ${r.scheme.padEnd(12)}${r.stack.padEnd(9)}${r.docLabel.padEnd(11)}${r.layers}`);
    continue;
  }
  const marks = r.cells.map((c) => (c.recovered ? 'Y' : '.').padEnd(7)).join('');
  line(
    `  ${r.scheme.padEnd(12)}${r.stack.padEnd(9)}${r.docLabel.padEnd(11)}${marks}` +
      `${(r.excerpt50 ? 'Y' : '.').padEnd(7)}${(r.excerpt20 ? 'Y' : '.').padEnd(7)}`,
  );
}
line();
line('  Y = token recovered and matched. . = lost.');
line();
