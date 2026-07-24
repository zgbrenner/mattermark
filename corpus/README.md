# Corpus

The survival harness runs against these documents. The headline numbers in the
top-level `README.md` were measured on **one** ~1.5k-char synthetic memo, and
that is not enough: survival is a function of document *shape*, not a constant.
A 40-page brief with a table of authorities, dense citations, and footnotes has
a completely different character-surface profile — whitespace density,
homoglyph-eligible letters, inter-word gaps — than a short memo, so it carries
and loses marks differently. This corpus spans that range so the matrix means
something.

Run it:

```bash
npm run matrix
```

## What these are (and are not)

Every file is a **synthetic fixture**. All parties, people, matters, addresses,
docket numbers, and facts are fictional. Real published statutes, rules, and
cases appear only as legal *authority* (e.g. `TransUnion LLC v. Ramirez`), which
is public law, not anyone's private information. Nothing here is a real
document, and nothing here is privileged.

Each file is a **clean ASCII canvas** — straight quotes, hyphen-minus, spaces
(no tabs) for all alignment, no pre-existing Unicode. That is deliberate: the
marking engine's job is to *add* the non-ASCII marks, so the source has to start
free of them, or the measured capacity would be polluted by characters the
author never intended as signal.

## The documents

Ordered smallest to largest — the same order the matrix prints.

| # | file | kind | ~chars | why it is in the corpus |
|---|------|------|-------:|-------------------------|
| 01 | `01-filing-notice.txt` | notice | 200 | below the ~400-char durability floor; proves the engine reports "too short" instead of silently degrading |
| 02 | `02-scheduling-email.txt` | email | 390 | right at the floor; durability depends on letter density, not raw length |
| 03 | `03-client-update-email.txt` | email | 1.0k | short prose |
| 04 | `04-privileged-memo.txt` | memo | 1.5k | the canonical memo the top-level README numbers were measured on |
| 05 | `05-engagement-letter.txt` | letter | 4.1k | aligned fee table (whitespace-heavy) |
| 06 | `06-demand-letter.txt` | letter | 3.1k | numbered demand list, UCC cite |
| 07 | `07-mutual-nda.txt` | contract | 5.0k | defined terms, numbered sections |
| 08 | `08-meet-and-confer.txt` | letter | 2.9k | dense Rule citations |
| 09 | `09-deposition-excerpt.txt` | transcript | 7.1k | Q&A with line numbers — lots of short lines and whitespace |
| 10 | `10-motion-to-dismiss.txt` | brief | 16.6k | nested headings, Bluebook citations, footnotes |
| 11 | `11-master-services-agreement.txt` | contract | 19.0k | pricing/SLA tables, SOW exhibit, cross-references |
| 12 | `12-expert-report.txt` | report | 14.9k | data tables + footnotes — number-heavy, so lower homoglyph density per char |
| 13 | `13-settlement-agreement.txt` | contract | 7.5k | recitals, payment schedule, signature blocks |
| 14 | `14-complaint.txt` | pleading | 13.4k | ~50 numbered allegations, multiple counts |
| 15 | `15-appellate-brief.txt` | brief | 55.1k | the 40-page marquee: cover, TOC, table of authorities, 19 footnotes, three nested argument sections, certificates |
| 16 | `16-regulatory-comment.txt` | filing | 9.3k | rulemaking comment with figure tables |

## What the corpus reveals that one memo hid

- **Durability is document-dependent.** The 200-char notice cannot carry a
  durable mark; the 390-char email can — because durability tracks the number of
  homoglyph-eligible letters, not the character count.
- **Excerpt resilience rises with size.** Deep (20%) excerpts stay attributable
  on the large brief, MSA, and report, and fall off on the smaller documents.
- **Structure shifts the channel mix.** Number- and table-heavy documents
  (expert report, MSA) spend a larger share of their characters on digits and
  punctuation, which lowers homoglyph capacity relative to raw length.

## Adding a document

Drop a `.txt` file in this directory and add one row to `MANIFEST` in
`src/corpus.ts`. Keep it ASCII-only (`npm run matrix` reads every file listed in
the manifest and fails loudly if one is missing).
