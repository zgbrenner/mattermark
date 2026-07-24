/**
 * transforms.ts — the four-tier transport-transform taxonomy (Raz et al. §3.3).
 *
 * These are the adversary/handling model. Every claim about robustness has to
 * be measured against these, not asserted.
 *
 * T12 (LLM paraphrase) is NOT implemented locally: it requires a model, and
 * faking it with a synonym shuffle would produce a dishonest number. It is
 * reported as NOT MEASURED rather than as a pass.
 */

import { foldConfusables } from './codecs/homoglyph.js';

export interface Transform {
  id: string;
  label: string;
  tier: number;
  apply: (s: string) => string;
}

export const T01: Transform = {
  id: 'T01',
  label: 'Copy-paste normalization',
  tier: 1,
  apply: (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
};

export const T02: Transform = {
  id: 'T02',
  label: 'Line reflow',
  tier: 1,
  apply: (s) =>
    s
      .split(/\n{2,}/)
      .map((para) => {
        const words = para.split(/\n/).join(' ');
        const out: string[] = [];
        let line = '';
        for (const w of words.split(/(?<= )/)) {
          if (line.length + w.length > 80) {
            out.push(line.replace(/\s+$/u, ''));
            line = '';
          }
          line += w;
        }
        if (line) out.push(line);
        return out.join('\n');
      })
      .join('\n\n'),
};

export const T03: Transform = {
  id: 'T03',
  label: 'Smart-quote replacement',
  tier: 1,
  apply: (s) =>
    s
      .replace(/(^|[\s(\[{])"/g, '$1\u201c')
      .replace(/"/g, '\u201d')
      .replace(/(^|[\s(\[{])'/g, '$1\u2018')
      .replace(/'/g, '\u2019'),
};

export const T04: Transform = {
  id: 'T04',
  label: 'Trailing-whitespace strip',
  tier: 1,
  apply: (s) => s.split('\n').map((l) => l.replace(/[^\S\n]+$/u, '')).join('\n'),
};

export const T05: Transform = {
  id: 'T05',
  label: 'Unicode NFKC normalization',
  tier: 2,
  apply: (s) => s.normalize('NFKC'),
};

export const T06: Transform = {
  id: 'T06',
  label: 'Whitespace collapse (ASCII)',
  tier: 2,
  apply: (s) => s.replace(/[ \t\f\v]{2,}/g, ' '),
};

export const T07: Transform = {
  id: 'T07',
  label: 'Format-character strip (Cf)',
  tier: 2,
  apply: (s) => s.replace(/\p{Cf}/gu, ''),
};

export const T08: Transform = {
  id: 'T08',
  label: 'Zero-width char stripping',
  tier: 3,
  apply: (s) => s.replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, ''),
};

export const T09: Transform = {
  id: 'T09',
  label: 'Homoglyph normalization',
  tier: 3,
  apply: (s) => foldConfusables(s),
};

export const T10: Transform = {
  id: 'T10',
  label: 'Full ASCII strip',
  tier: 3,
  apply: (s) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x00-\x7f]/g, ''),
};

export const T11: Transform = {
  id: 'T11',
  label: 'Punctuation/case strip',
  tier: 4,
  apply: (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ''),
};

export const ALL_TRANSFORMS = [T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11];

export interface Chain {
  name: string;
  models: string;
  steps: Transform[];
}

const chain = (steps: Transform[]) => (s: string) => steps.reduce((acc, t) => t.apply(acc), s);

export const CHAINS: Chain[] = [
  { name: 'Tier-0', models: 'Baseline / control', steps: [] },
  { name: 'Tier-1', models: 'User copy-paste', steps: [T01, T02, T03, T04] },
  { name: 'Tier-2', models: 'Platform sanitization', steps: [T05, T06, T07] },
  { name: 'Tier-3', models: 'Steganography-aware attacker', steps: [T08, T09, T10] },
  { name: 'Tier-1+2', models: 'Combined incidental processing', steps: [T01, T02, T03, T04, T05, T06, T07] },
  {
    name: 'Tier-1+2+3',
    models: 'Maximum non-semantic pipeline',
    steps: [T01, T02, T03, T04, T05, T06, T07, T08, T09, T10],
  },
  { name: 'T11 (punct/case)', models: 'Content normalization', steps: [T11] },
];

export function applyChain(c: Chain, s: string): string {
  return chain(c.steps)(s);
}

/** Excerpting: take a contiguous middle slice. The dominant legal-leak shape. */
export function excerpt(s: string, fraction: number): string {
  const chars = Array.from(s);
  const len = Math.floor(chars.length * fraction);
  const start = Math.floor((chars.length - len) / 2);
  return chars.slice(start, start + len).join('');
}
