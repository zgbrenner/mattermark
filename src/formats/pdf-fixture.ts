/** Controlled classic-xref PDF fixture writer for demos and tests. */

import { deflateSync } from 'node:zlib';
import { bfcharBlocks, streamObject, utf16beHex } from './pdf-xref.js';

/**
 * Build a small spec-compliant PDF used by demos and tests. This is not a
 * general renderer. Its text layer is faithful and its structure is classic
 * xref, which makes it a controlled fixture for the reader and marker.
 */
export function buildTextPdf(text: string): Buffer {
  const chars = [...text];
  const unique = [...new Set(chars)];
  if (unique.length > 255) {
    throw new Error('buildTextPdf: too many distinct characters for a 1-byte demo font');
  }
  const codeOf = new Map<string, number>(unique.map((ch, index) => [ch, index + 1]));
  const hex2 = (value: number): string => value.toString(16).padStart(2, '0');

  const shown = chars
    .map((ch) => `\\${codeOf.get(ch)!.toString(8).padStart(3, '0')}`)
    .join('');
  const content = `BT /F1 12 Tf 72 720 Td (${shown}) Tj ET`;
  const contentDeflated = deflateSync(Buffer.from(content, 'latin1'));

  const mappings = unique.map(
    (ch) => `<${hex2(codeOf.get(ch)!)}> <${utf16beHex(ch)}>`,
  );
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
${bfcharBlocks(mappings)}
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const cmapDeflated = deflateSync(Buffer.from(cmap, 'latin1'));

  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      'latin1',
    ),
    Buffer.from(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
      'latin1',
    ),
    streamObject(
      `<< /Length ${contentDeflated.length} /Filter /FlateDecode >>`,
      contentDeflated,
    ),
    streamObject(
      `<< /Length ${cmapDeflated.length} /Filter /FlateDecode >>`,
      cmapDeflated,
    ),
  ];

  const header = Buffer.from('%PDF-1.5\n%\xff\xff\xff\xff\n', 'latin1');
  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let position = header.length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(object);
    position += object.length;
  });

  const xrefStart = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  xref +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}
