/**
 * harness.ts — measured survival matrix. No claims, only numbers.
 */

import { mark, detect, CODECS, MarkOptions } from './orchestrator.js';
import { CHAINS, applyChain, excerpt } from './transforms.js';
import { newCopyIdentity, hmacIssuer, ed25519Issuer, deriveEd25519, Issuer } from './crypto.js';
import { Scheme } from './frame.js';
import { randomBytes } from 'node:crypto';

export interface Cell {
  chain: string;
  recovered: boolean;
  channels: string[];
}

export interface Row {
  scheme: string;
  stack: string;
  docLabel: string;
  durable: boolean;
  /** true if the HG channel actually substituted glyphs (search-breaking) */
  homoglyphActive: boolean;
  layers: string;
  cells: Cell[];
  excerpt50: boolean;
  excerpt20: boolean;
}

export function runMatrix(
  docs: Array<{ label: string; text: string }>,
  stacks: Array<Array<'WS' | 'ZW' | 'HG'>>,
  markOpts: Omit<MarkOptions, 'codecs'> = {},
): Row[] {
  const orgKey = randomBytes(32);
  const kp = deriveEd25519(orgKey);
  const rows: Row[] = [];

  const issuers: Array<{ name: string; make: (reg: Set<string>) => Issuer }> = [
    { name: 'HMAC-SHA256', make: (reg) => hmacIssuer(orgKey, (h) => reg.has(h)) },
    { name: 'Ed25519', make: () => ed25519Issuer(kp, orgKey) },
  ];

  for (const doc of docs) {
    for (const stack of stacks) {
      for (const iss of issuers) {
        const reg = new Set<string>();
        const issuer = iss.make(reg);
        const identity = newCopyIdentity('MATTER-2026-0417', 'opposing.counsel@example.com', 'v3');

        let marked;
        try {
          marked = mark(doc.text, identity, issuer, { codecs: stack, ...markOpts });
        } catch (e) {
          rows.push({
            scheme: iss.name,
            stack: stack.join('+'),
            docLabel: doc.label,
            durable: false,
            homoglyphActive: false,
            layers: `REJECTED: ${(e as Error).message}`,
            cells: [],
            excerpt50: false,
            excerpt20: false,
          });
          continue;
        }
        reg.add(marked.tokenHex);

        const cells: Cell[] = CHAINS.map((chain) => {
          const transformed = applyChain(chain, marked.text);
          const res = detect(transformed, stack);
          const hit = res.tokens.find(
            (t) => t.tokenHex === marked.tokenHex || t.tokenHex === marked.shortIdHex,
          );
          return {
            chain: chain.name,
            recovered: Boolean(hit),
            channels: hit ? hit.channels : [],
          };
        });

        const ex = (f: number) => {
          const res = detect(excerpt(marked.text, f), stack);
          return res.tokens.some(
            (t) => t.tokenHex === marked.tokenHex || t.tokenHex === marked.shortIdHex,
          );
        };

        rows.push({
          scheme: iss.name,
          stack: stack.join('+'),
          docLabel: doc.label,
          durable: marked.durable,
          homoglyphActive: marked.layers.some((l) => l.codec === 'HG' && l.embedded),
          layers: marked.layers
            .map((l) =>
              l.embedded
                ? `${l.codec}${l.payload === 'short' ? '~' : ''}x${l.copiesEmbedded.toFixed(1)}`
                : `${l.codec}:FAIL`,
            )
            .join(' '),
          cells,
          excerpt50: ex(0.5),
          excerpt20: ex(0.2),
        });
      }
    }
  }
  return rows;
}

export function capacityReport(text: string): string {
  return (['WS', 'ZW', 'HG'] as const)
    .map((id) => {
      const c = CODECS[id];
      const digits = c.capacityDigits(text);
      const bits = digits * Math.log2(c.base);
      return `${id}: ${digits} digits (${bits} bits, ${Math.floor(bits / 8)} bytes)`;
    })
    .join('\n  ');
}

export const SCHEME_NAME: Record<number, string> = {
  [Scheme.HMAC_SHA256]: 'HMAC-SHA256',
  [Scheme.ED25519]: 'Ed25519',
};
