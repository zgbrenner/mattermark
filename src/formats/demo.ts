/**
 * formats/demo.ts — Slice 2 walkthrough: mark a real DOCX and attribute it.
 *
 * Builds a DOCX from a corpus document, marks it for a recipient, shows that
 * only the document text changed, recovers the token from the marked DOCX, and
 * measures survival against the transform taxonomy on the extracted text.
 */

import { randomBytes } from 'node:crypto';
import { textToDocx, markDocx, detectDocx, readDocxText } from './index.js';
import { readZip } from './zip.js';
import { detect } from '../orchestrator.js';
import { newCopyIdentity, ed25519Issuer, deriveEd25519 } from '../crypto.js';
import { foldConfusables } from '../codecs/homoglyph.js';
import { CHAINS, applyChain, excerpt } from '../transforms.js';
import { loadCorpus } from '../corpus.js';

function line(s = '') {
  console.log(s);
}
function rule(title: string) {
  line();
  line('='.repeat(78));
  line(title);
  line('='.repeat(78));
}

const corpus = loadCorpus();
const orgKey = randomBytes(32);
const kp = deriveEd25519(orgKey);

for (const label of ['priv-memo', 'appellate-brief']) {
  const doc = corpus.find((d) => d.label === label)!;

  rule(`DOCX: ${doc.label} (${doc.kind}, ${doc.chars} source chars)`);

  // 1. Build a real DOCX (a ZIP of OOXML parts).
  const docx = textToDocx(doc.text);
  const parts = readZip(docx).map((e) => e.name);
  line(`  built DOCX: ${docx.length} bytes, parts: ${parts.join(', ')}`);

  // 2. Mark it for a recipient.
  const identity = newCopyIdentity(doc.label.toUpperCase(), 'opposing.counsel@example.com', 'v3');
  const { bytes: marked, result } = markDocx(docx, identity, ed25519Issuer(kp, orgKey), {
    codecs: ['WS', 'ZW', 'HG'],
  });
  line(`  marked DOCX: ${marked.length} bytes  durable=${result.durable}`);
  line(
    '  layers: ' +
      result.layers
        .map((l) => (l.embedded ? `${l.codec} x${l.copiesEmbedded.toFixed(1)}` : `${l.codec}:skip`))
        .join('  '),
  );

  // 3. Only the document text changed; every other part is byte-identical, and
  //    the rendered letters are unchanged once confusables are folded back.
  const before = readZip(docx);
  const after = readZip(marked);
  const untouched = before
    .filter((e) => e.name !== 'word/document.xml')
    .every((e) => e.data.equals(after.find((a) => a.name === e.name)!.data));
  line(`  non-text parts byte-identical: ${untouched}`);
  const markedText = readDocxText(marked);
  line(`  visible text unchanged after folding confusables: ${foldConfusables(markedText) === markedText ? 'n/a' : 'homoglyphs present'}`);

  // 4. Attribute from the marked DOCX.
  const det = detectDocx(marked, ['WS', 'ZW', 'HG']);
  const hit = det.tokens.find((t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex);
  line(`  ATTRIBUTED from marked DOCX: ${Boolean(hit)}  (channels: ${hit?.channels.join(', ') ?? '-'})`);

  // 5. Survival across the transform taxonomy, on the extracted text.
  line('  survival on the extracted text:');
  for (const chain of CHAINS) {
    const transformed = applyChain(chain, markedText);
    const d = detect(transformed, ['WS', 'ZW', 'HG']);
    const ok = d.tokens.some((t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex);
    line(`    ${chain.name.padEnd(16)} ${ok ? 'recovered' : 'lost'}`);
  }
  const ex = detect(excerpt(markedText, 0.5), ['WS', 'ZW', 'HG']);
  line(
    `    50% excerpt      ${ex.tokens.some((t) => t.tokenHex === result.tokenHex || t.tokenHex === result.shortIdHex) ? 'recovered' : 'lost'}`,
  );
}

rule('SEARCH-SAFE DOCX (no homoglyph substitution)');
{
  const doc = corpus.find((d) => d.label === 'priv-memo')!;
  const docx = textToDocx(doc.text);
  const identity = newCopyIdentity('SEARCH-SAFE', 'opposing.counsel@example.com', 'v3');
  const { bytes: marked, result } = markDocx(docx, identity, ed25519Issuer(kp, orgKey), {
    codecs: ['WS', 'ZW'],
    allowNonDurable: true,
  });
  const text = readDocxText(marked);
  line(`  durable=${result.durable}  homoglyph substitutions=${text.length - foldConfusables(text).length === 0 ? 0 : 'some'}`);
  line(`  every visible letter intact (keyword search preserved): ${foldConfusables(text) === text}`);
  line(`  warnings:`);
  for (const w of result.warnings) line('    ! ' + w.replace(/\s+/g, ' '));
}
line();
