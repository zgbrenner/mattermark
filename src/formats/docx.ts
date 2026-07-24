/**
 * docx.ts — extract text from a DOCX, and reinject marked text without
 * disturbing anything else in the document.
 *
 * A DOCX stores visible text as a sequence of `<w:t>` runs inside
 * `word/document.xml`. We concatenate those runs into one string, hand it to
 * the marking engine, and then split the marked string back across the same
 * runs. Detection re-extracts and re-concatenates identically, so the exact run
 * a boundary character lands in does not affect recovery — only that no
 * character is lost or reordered, which the distribution below guarantees.
 *
 * The one subtlety is the zero-width codec: it INSERTS characters, so the marked
 * string is longer than the source. We therefore split by counting "content"
 * (non-zero-width) code points per run, letting inserted markers ride along in
 * whichever run they fall in. The source must not already contain the
 * zero-width alphabet, or the count would be wrong; `containsZeroWidth` lets
 * callers guard against that.
 */

export const DOCUMENT_PART = 'word/document.xml';

/** The zero-width insertion alphabet (see codecs/zerowidth.ts). */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060]);

/** Matches a `<w:t>` element (with optional attributes) and its text content.
 *  Deliberately does not match `<w:tab/>`, `<w:tbl>`, or `<w:t/>` (empty). */
const WT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

export function containsZeroWidth(s: string): boolean {
  for (const ch of s) if (ZERO_WIDTH.has(ch.codePointAt(0) as number)) return true;
  return false;
}

function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return e[1] === 'x' || e[1] === 'X'
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : String.fromCodePoint(parseInt(e.slice(1), 10));
    }
  });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The concatenated visible text of a document part, in run order. */
export function extractText(documentXml: string): string {
  let out = '';
  for (const m of documentXml.matchAll(WT_RE)) out += unescapeXml(m[1]);
  return out;
}

/** Per-run code-point lengths, in run order — the shape reinjection fills. */
function runLengths(documentXml: string): number[] {
  const lens: number[] = [];
  for (const m of documentXml.matchAll(WT_RE)) lens.push([...unescapeXml(m[1])].length);
  return lens;
}

/** Distribute `marked` across runs of the given content lengths, losslessly.
 *  Zero-width markers are additive and ride along in the current run. */
function distribute(marked: string, lengths: number[]): string[] {
  const out = lengths.map(() => '');
  const remaining = [...lengths];
  let node = 0;
  for (const ch of marked) {
    if (ZERO_WIDTH.has(ch.codePointAt(0) as number)) {
      out[node] += ch; // inserted marker: no content quota consumed
      continue;
    }
    while (node < out.length - 1 && remaining[node] === 0) node++;
    out[node] += ch;
    if (remaining[node] > 0) remaining[node]--;
  }
  return out;
}

/**
 * Replace the document's run text with `markedText`, distributed across the
 * original runs. Forces xml:space="preserve" so substituted spaces are kept.
 * The number of runs is unchanged, so all other structure is preserved exactly.
 */
export function reinjectText(documentXml: string, markedText: string): string {
  const segments = distribute(markedText, runLengths(documentXml));
  let i = 0;
  return documentXml.replace(WT_RE, () => {
    const seg = segments[i++] ?? '';
    return `<w:t xml:space="preserve">${escapeXml(seg)}</w:t>`;
  });
}

/* ------------------------------ docx builder ----------------------------- */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Build a minimal, valid document.xml. Each paragraph is one run; passing an
 *  array of runs per paragraph exercises multi-run paragraphs (for tests). */
export function buildDocumentXml(paragraphs: Array<string | string[]>): string {
  const body = paragraphs
    .map((p) => {
      const runs = (Array.isArray(p) ? p : [p])
        .map((r) => `<w:r><w:t xml:space="preserve">${escapeXml(r)}</w:t></w:r>`)
        .join('');
      return `<w:p>${runs}</w:p>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

/** The three parts of a minimal DOCX, given a document.xml. */
export function docxParts(documentXml: string): Array<{ name: string; text: string }> {
  return [
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels', text: ROOT_RELS },
    { name: DOCUMENT_PART, text: documentXml },
  ];
}
