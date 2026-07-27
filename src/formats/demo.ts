/**
 * formats/demo.ts - Slice 2 walkthrough for DOCX and PDF marking.
 */

import { randomBytes } from 'node:crypto';
import {
  textToDocx,
  markDocx,
  detectDocx,
  readDocxText,
  buildTextPdf,
  markPdf,
  extractPdfText,
  extractMattermarkPdfCarrier,
  detectPdf,
} from './index.js';
import { readZip } from './zip.js';
import { detect } from '../orchestrator.js';
import { newCopyIdentity, ed25519Issuer, deriveEd25519 } from '../crypto.js';
import { foldConfusables } from '../codecs/homoglyph.js';
import { CHAINS, applyChain, excerpt } from '../transforms.js';
import { loadCorpus } from '../corpus.js';

function line(text = ''): void {
  console.log(text);
}

function rule(title: string): void {
  line();
  line('='.repeat(78));
  line(title);
  line('='.repeat(78));
}

const corpus = loadCorpus();
const orgKey = randomBytes(32);
const keyPair = deriveEd25519(orgKey);

for (const label of ['priv-memo', 'appellate-brief']) {
  const document = corpus.find((item) => item.label === label)!;
  rule(`DOCX: ${document.label} (${document.kind}, ${document.chars} source chars)`);

  const docx = textToDocx(document.text);
  const parts = readZip(docx).map((entry) => entry.name);
  line(`  built DOCX: ${docx.length} bytes, parts: ${parts.join(', ')}`);

  const identity = newCopyIdentity(
    document.label.toUpperCase(),
    'opposing.counsel@example.com',
    'v3',
  );
  const { bytes: marked, result } = markDocx(
    docx,
    identity,
    ed25519Issuer(keyPair, orgKey),
    { codecs: ['WS', 'ZW', 'HG'] },
  );
  line(`  marked DOCX: ${marked.length} bytes  durable=${result.durable}`);
  line(
    '  layers: ' +
      result.layers
        .map((layer) =>
          layer.embedded
            ? `${layer.codec} x${layer.copiesEmbedded.toFixed(1)}`
            : `${layer.codec}:skip`,
        )
        .join('  '),
  );

  const before = readZip(docx);
  const after = readZip(marked);
  const untouched = before
    .filter((entry) => entry.name !== 'word/document.xml')
    .every((entry) =>
      entry.data.equals(after.find((candidate) => candidate.name === entry.name)!.data),
    );
  line(`  non-text parts byte-identical: ${untouched}`);
  const markedText = readDocxText(marked);
  line(
    `  visible text after confusable folding: ${
      foldConfusables(markedText) === markedText ? 'no homoglyphs' : 'homoglyphs present'
    }`,
  );

  const recovered = detectDocx(marked, ['WS', 'ZW', 'HG']);
  const hit = recovered.tokens.find(
    (token) => token.tokenHex === result.tokenHex || token.tokenHex === result.shortIdHex,
  );
  line(
    `  ATTRIBUTED from marked DOCX: ${Boolean(hit)}  ` +
      `(channels: ${hit?.channels.join(', ') ?? '-'})`,
  );

  line('  survival on the extracted text:');
  for (const chain of CHAINS) {
    const transformed = applyChain(chain, markedText);
    const detection = detect(transformed, ['WS', 'ZW', 'HG']);
    const survived = detection.tokens.some(
      (token) =>
        token.tokenHex === result.tokenHex || token.tokenHex === result.shortIdHex,
    );
    line(`    ${chain.name.padEnd(16)} ${survived ? 'recovered' : 'lost'}`);
  }
  const excerptDetection = detect(excerpt(markedText, 0.5), ['WS', 'ZW', 'HG']);
  line(
    `    50% excerpt      ${
      excerptDetection.tokens.some(
        (token) =>
          token.tokenHex === result.tokenHex || token.tokenHex === result.shortIdHex,
      )
        ? 'recovered'
        : 'lost'
    }`,
  );
}

rule('SEARCH-SAFE DOCX (no homoglyph substitution)');
{
  const document = corpus.find((item) => item.label === 'priv-memo')!;
  const docx = textToDocx(document.text);
  const identity = newCopyIdentity(
    'SEARCH-SAFE',
    'opposing.counsel@example.com',
    'v3',
  );
  const { bytes: marked, result } = markDocx(
    docx,
    identity,
    ed25519Issuer(keyPair, orgKey),
    { codecs: ['WS', 'ZW'], allowNonDurable: true },
  );
  const text = readDocxText(marked);
  line(`  durable=${result.durable}`);
  line(`  every visible letter intact: ${foldConfusables(text) === text}`);
  line('  warnings:');
  for (const warning of result.warnings) {
    line(`    ! ${warning.replace(/\s+/g, ' ')}`);
  }
}

rule('PDF: invisible incremental carrier, visible layout untouched');
{
  const document = corpus.find((item) => item.label === 'priv-memo')!;
  const identity = newCopyIdentity(
    'MATTER-2026-0417',
    'opposing.counsel@example.com',
    'v3',
  );
  const original = buildTextPdf(document.text);
  const marked = markPdf(
    original,
    identity,
    ed25519Issuer(keyPair, orgKey),
    { codecs: ['WS', 'ZW', 'HG'] },
  );
  line(`  original bytes preserved as prefix: ${marked.bytes.subarray(0, original.length).equals(original)}`);
  line(`  ordinary visible text unchanged: ${extractPdfText(marked.bytes) === document.text}`);
  line(`  pages carrying the shared mark: ${marked.pagesMarked}`);
  line(`  hidden carrier chars: ${extractMattermarkPdfCarrier(marked.bytes).length}`);

  const detection = detectPdf(marked.bytes, ['WS', 'ZW', 'HG']);
  const hit = detection.tokens.find(
    (token) =>
      token.tokenHex === marked.result.tokenHex ||
      token.tokenHex === marked.result.shortIdHex,
  );
  line(
    `  ATTRIBUTED from marked PDF: ${Boolean(hit)}  ` +
      `(channels: ${hit?.channels.join(', ') ?? '-'})`,
  );
  line('  warnings:');
  for (const warning of marked.result.warnings) {
    line(`    ! ${warning.replace(/\s+/g, ' ')}`);
  }
}

line();
