/**
 * corpus.ts — the document corpus the survival harness runs against.
 *
 * The headline survival numbers in README.md were measured on ONE ~1.5k-char
 * synthetic memo. Those numbers do not transfer: a 40-page appellate brief with
 * a table of authorities, dense citations, and footnotes has a completely
 * different character-surface profile (whitespace density, homoglyph-eligible
 * letters, inter-word gaps) than a short memo, so it carries — and loses — marks
 * differently. This corpus makes the matrix meaningful by spanning realistic
 * document sizes and structures.
 *
 * Every document is a SYNTHETIC fixture: fictional parties, matters, people, and
 * facts. Real statutes and published cases appear only as legal authority. Each
 * file is a clean ASCII canvas so measured capacity reflects the marks the
 * engine adds, not pre-existing Unicode in the source. See corpus/README.md.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface CorpusEntry {
  /** filename within corpus/ */
  file: string;
  /** short label used in the survival matrix */
  label: string;
  /** document category */
  kind:
    | 'notice'
    | 'email'
    | 'memo'
    | 'letter'
    | 'contract'
    | 'transcript'
    | 'brief'
    | 'report'
    | 'pleading'
    | 'filing';
  /** one-line description of the structural features that make it distinct */
  note: string;
}

export interface CorpusDoc extends CorpusEntry {
  text: string;
  /** length in Unicode code points (== bytes for the ASCII fixtures) */
  chars: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(HERE, '..', 'corpus');

/**
 * Ordered smallest-to-largest so the matrix reads as a size sweep. The manifest
 * is the single source of truth for what is in the corpus; loadCorpus() fails
 * loudly if a listed file is missing rather than silently shrinking coverage.
 */
export const MANIFEST: CorpusEntry[] = [
  { file: '01-filing-notice.txt',            label: 'filing-notice',    kind: 'notice',     note: 'ECF docket notice; below the ~400-char durability floor' },
  { file: '02-scheduling-email.txt',         label: 'sched-email',      kind: 'email',      note: 'short attorney email; near the durability floor' },
  { file: '03-client-update-email.txt',      label: 'client-email',     kind: 'email',      note: 'short prose status update' },
  { file: '04-privileged-memo.txt',          label: 'priv-memo',        kind: 'memo',       note: 'the canonical ~1.5k privileged memo (README baseline)' },
  { file: '05-engagement-letter.txt',        label: 'engagement',       kind: 'letter',     note: 'engagement letter with an aligned fee table' },
  { file: '06-demand-letter.txt',            label: 'demand-letter',    kind: 'letter',     note: 'pre-litigation demand with a numbered demand list' },
  { file: '07-mutual-nda.txt',               label: 'mutual-nda',       kind: 'contract',   note: 'mutual NDA; defined terms, numbered sections' },
  { file: '08-meet-and-confer.txt',          label: 'meet-confer',      kind: 'letter',     note: 'discovery letter dense with Rule cites' },
  { file: '09-deposition-excerpt.txt',       label: 'depo-excerpt',     kind: 'transcript', note: 'Q&A transcript with line numbers (whitespace-heavy)' },
  { file: '10-motion-to-dismiss.txt',        label: 'mtd-brief',        kind: 'brief',      note: '12(b)(6) brief; nested headings, citations, footnotes' },
  { file: '11-master-services-agreement.txt', label: 'msa',             kind: 'contract',   note: 'MSA with pricing/SLA tables and an SOW exhibit' },
  { file: '12-expert-report.txt',            label: 'expert-report',    kind: 'report',     note: 'damages report; data tables + footnotes (number-heavy)' },
  { file: '13-settlement-agreement.txt',     label: 'settlement',       kind: 'contract',   note: 'settlement + release; recitals, payment schedule' },
  { file: '14-complaint.txt',                label: 'complaint',        kind: 'pleading',   note: 'civil complaint; ~50 numbered allegations, counts' },
  { file: '15-appellate-brief.txt',          label: 'appellate-brief',  kind: 'brief',      note: '~40 pages: TOC, table of authorities, 25+ footnotes' },
  { file: '16-regulatory-comment.txt',       label: 'reg-comment',      kind: 'filing',     note: 'rulemaking comment with figure tables' },
];

export function loadCorpus(): CorpusDoc[] {
  const missing = MANIFEST.filter((e) => !existsSync(join(CORPUS_DIR, e.file)));
  if (missing.length) {
    throw new Error(
      `corpus files missing (${missing.length}): ${missing.map((m) => m.file).join(', ')}`,
    );
  }
  return MANIFEST.map((e) => {
    const text = readFileSync(join(CORPUS_DIR, e.file), 'utf8');
    return { ...e, text, chars: [...text].length };
  });
}
