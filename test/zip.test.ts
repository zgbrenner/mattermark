import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, readZip, writeZip, ZipEntry } from '../src/formats/zip.js';

test('crc32 matches the canonical check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('writeZip/readZip round-trips names, order, and bytes', () => {
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from('<w:document>text &amp; more</w:document>', 'utf8') },
    { name: 'dir/empty.bin', data: Buffer.alloc(0) },
    { name: 'binary', data: Buffer.from([0, 1, 2, 255, 254, 128, 0]) },
  ];
  const round = readZip(writeZip(entries));
  assert.equal(round.length, entries.length);
  for (let i = 0; i < entries.length; i++) {
    assert.equal(round[i].name, entries[i].name); // order preserved
    assert.ok(round[i].data.equals(entries[i].data), `${entries[i].name} bytes preserved`);
  }
});

test('readZip survives a large, compressible payload', () => {
  const data = Buffer.from('the quick brown fox '.repeat(5000), 'utf8');
  const zipped = writeZip([{ name: 'big.txt', data }]);
  assert.ok(zipped.length < data.length, 'deflate actually compressed it');
  assert.ok(readZip(zipped)[0].data.equals(data));
});

test('readZip rejects a non-zip buffer', () => {
  assert.throws(() => readZip(Buffer.from('not a zip file at all')), /central-directory/);
});
