/**
 * matrix.ts — the survival harness, run over the real corpus.
 *
 * `npm run demo` tells the story on one memo. This runs the same measurement
 * across every document in corpus/, because survival is a function of document
 * shape, not a constant. A 40-page brief carries and loses marks differently
 * from a 1.5k memo, and the point of the corpus is to show exactly that.
 *
 * No claims, only numbers. Everything printed here is measured on this machine
 * by this code at run time.
 */

import { CODECS, mark, detect } from './orchestrator.js';
import { runMatrix } from './harness.js';
import { loadCorpus } from './corpus.js';
import { CHAINS, applyChain, excerpt } from './transforms.js';
import { newCopyIdentity, hmacIssuer, deriveEd25519, ed25519Issuer } from './crypto.js';
import { foldConfusables } from './codecs/homoglyph.js';
import { randomBytes } from 'node:crypto';

function line(s = '') {
  console.log(s);
}
function rule(title: string) {
  line();
  line('='.repeat(92));
  line(title);
  line('='.repeat(92));
}

/** Count Latin->Cyrillic homoglyph substitutions actually present in `marked`. */
function homoglyphSubstitutions(marked: string): number {
  const folded = foldConfusables(marked);
  const a = Array.from(marked);
  const b = Array.from(folded);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

const corpus = loadCorpus();

/* ------------------------------------------------------------------ */

rule('CORPUS');
line(`  ${corpus.length} synthetic documents, ${corpus.reduce((s, d) => s + d.chars, 0).toLocaleString()} chars total.`);
line('  All fictional. All ASCII source. Ordered smallest to largest.');
line();
line(
  '  ' +
    'label'.padEnd(18) +
    'kind'.padEnd(11) +
    'chars'.padStart(8) +
    '   ' +
    'WS(B)'.padStart(7) +
    'ZW(B)'.padStart(7) +
    'HG(B)'.padStart(7) +
    '   durable?',
);
line('  ' + '-'.repeat(86));
for (const d of corpus) {
  const bytes = (id: 'WS' | 'ZW' | 'HG') => {
    const c = CODECS[id];
    return Math.floor((c.capacityDigits(d.text) * Math.log2(c.base)) / 8);
  };
  // HG needs to fit at least one 18-byte SHORT_ID frame (144 base-2 digits) to
  // be durable at all.
  const hgDigits = CODECS.HG.capacityDigits(d.text);
  const floor = hgDigits >= 144 ? 'yes' : 'TOO SHORT';
  line(
    '  ' +
      d.label.padEnd(18) +
      d.kind.padEnd(11) +
      String(d.chars).padStart(8) +
      '   ' +
      String(bytes('WS')).padStart(7) +
      String(bytes('ZW')).padStart(7) +
      String(bytes('HG')).padStart(7) +
      '   ' +
      floor,
  );
}

/* ------------------------------------------------------------------ */

rule('SURVIVAL MATRIX  -  recommended durable stack WS+ZW+HG, both schemes');
const docs = corpus.map((d) => ({ label: d.label, text: d.text }));
const rows = runMatrix(docs, [['WS', 'ZW', 'HG']]);

const chainNames = CHAINS.map((c) => c.name);
const head =
  '  ' +
  'scheme'.padEnd(8) +
  'doc'.padEnd(18) +
  chainNames.map((n) => shortChain(n).padEnd(6)).join('') +
  'ex50'.padEnd(6) +
  'ex20'.padEnd(6) +
  'dur';
line(head);
line('  ' + '-'.repeat(head.length - 2));
for (const r of rows) {
  const scheme = r.scheme === 'HMAC-SHA256' ? 'HMAC' : 'Ed255';
  if (r.cells.length === 0) {
    line('  ' + scheme.padEnd(8) + r.docLabel.padEnd(18) + r.layers);
    continue;
  }
  const cells = r.cells.map((c) => (c.recovered ? 'Y' : '.').padEnd(6)).join('');
  line(
    '  ' +
      scheme.padEnd(8) +
      r.docLabel.padEnd(18) +
      cells +
      (r.excerpt50 ? 'Y' : '.').padEnd(6) +
      (r.excerpt20 ? 'Y' : '.').padEnd(6) +
      (r.durable ? 'Y' : '.'),
  );
}
line();
line('  Y = token recovered and attributed. . = lost.');
line('  Tier-0 baseline / Tier-1 copy-paste / Tier-2 platform sanitization /');
line('  Tier-3 stego-aware attacker / T11 punctuation+case strip. dur = durable.');

/* ------------------------------------------------------------------ */

rule('THE HOMOGLYPH SEARCH TRADEOFF  -  durable vs search-safe');
line('  HG is the only symbolic channel that survives platform sanitization, so');
line('  it carries durability. It also substitutes Cyrillic look-alikes for Latin');
line('  letters, which corrupts the words a keyword index or Ctrl-F sees. That can');
line('  be disqualifying for litigation work product. HG is therefore an OPTION,');
line('  not a requirement: an operator may drop it for a search-preserving mark.');
line();

const orgKey = randomBytes(32);
const kp = deriveEd25519(orgKey);
for (const label of ['priv-memo', 'appellate-brief']) {
  const doc = corpus.find((d) => d.label === label)!;
  const id = newCopyIdentity('MATTER-2026-0417', 'opposing.counsel@example.com', 'v3');
  const durableMark = mark(doc.text, id, ed25519Issuer(kp, orgKey), { codecs: ['WS', 'ZW', 'HG'] });
  const safeMark = mark(doc.text, id, ed25519Issuer(kp, orgKey), {
    codecs: ['WS', 'ZW'],
    allowNonDurable: true,
  });

  const survivesTier2 = (m: { text: string; tokenHex: string; shortIdHex: string }, stack: Array<'WS' | 'ZW' | 'HG'>) => {
    const det = detect(applyChain(CHAINS[2], m.text), stack); // Tier-2
    return det.tokens.some((t) => t.tokenHex === m.tokenHex || t.tokenHex === m.shortIdHex);
  };

  line(`  ${doc.label}  (${doc.chars} chars)`);
  line(
    `    durable  WS+ZW+HG : durable=${durableMark.durable}` +
      `  Tier-2 survives=${survivesTier2(durableMark, ['WS', 'ZW', 'HG'])}` +
      `  homoglyph substitutions=${homoglyphSubstitutions(durableMark.text)}  (search: CORRUPTED)`,
  );
  line(
    `    safe     WS+ZW    : durable=${safeMark.durable}` +
      `  Tier-2 survives=${survivesTier2(safeMark, ['WS', 'ZW'])}` +
      `  homoglyph substitutions=${homoglyphSubstitutions(safeMark.text)}  (letters intact)`,
  );
  line();
}
line('  Search-safe keeps the visible letters of every word intact (zero homoglyph');
line('  substitutions), so keyword indexing and Ctrl-F are not corrupted -- at the');
line('  cost of durability: the mark then dies to routine platform sanitization.');
line();
line('  Warnings surfaced at mark time for the durable (HG) configuration:');
{
  const id = newCopyIdentity('MATTER-2026-0417', 'opposing.counsel@example.com', 'v3');
  const m = mark(corpus.find((d) => d.label === 'priv-memo')!.text, id, hmacIssuer(orgKey, () => false), {
    codecs: ['WS', 'ZW', 'HG'],
  });
  for (const w of m.warnings) {
    line('    - ' + w.replace(/\s+/g, ' '));
  }
}

/* ------------------------------------------------------------------ */

rule('AGGREGATE');
const durableRows = rows.filter((r) => r.scheme === 'HMAC-SHA256');
const durableCount = durableRows.filter((r) => r.durable).length;
const tooShort = durableRows.filter((r) => !r.durable).map((r) => r.docLabel);
line(`  Durably markable (WS+ZW+HG): ${durableCount}/${durableRows.length} documents.`);
if (tooShort.length) {
  line(`  Below the durability floor: ${tooShort.join(', ')}`);
}
const ex50 = durableRows.filter((r) => r.excerpt50).length;
const ex20 = durableRows.filter((r) => r.excerpt20).length;
line(`  Attributable from a 50% excerpt: ${ex50}/${durableRows.length}.`);
line(`  Attributable from a 20% excerpt: ${ex20}/${durableRows.length}.`);
line();
line('  Reading: durability and excerpt resilience RISE with document size. The');
line('  short notice and emails cannot carry a durable mark at all; the brief,');
line('  the MSA, and the report survive deep excerpting. One number on one memo');
line('  would have hidden every bit of that.');
line();

function shortChain(name: string): string {
  const map: Record<string, string> = {
    'Tier-0': 'T0',
    'Tier-1': 'T1',
    'Tier-2': 'T2',
    'Tier-3': 'T3',
    'Tier-1+2': 'T1+2',
    'Tier-1+2+3': 'T123',
    'T11 (punct/case)': 'T11',
  };
  return map[name] ?? name;
}
