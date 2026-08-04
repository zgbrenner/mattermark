import { test } from 'node:test';
import assert from 'node:assert/strict';

import { merkleRoot, sha256hex } from '../src/ledger/hashchain.js';
import {
  createMerkleProof,
  verifyMerkleProof,
  type MerkleInclusionProof,
} from '../src/ledger/merkle-proof.js';

function leaves(size: number): string[] {
  return Array.from({ length: size }, (_, i) => sha256hex(`leaf-${i}`));
}

function cloneProof(proof: MerkleInclusionProof): MerkleInclusionProof {
  return {
    ...proof,
    path: proof.path.map((step) => ({ ...step })),
  };
}

for (const size of [1, 2, 3, 4, 5, 7, 8]) {
  test(`proofs verify for every leaf in a ${size}-leaf tree`, () => {
    const hashes = leaves(size);
    for (let i = 0; i < hashes.length; i++) {
      const proof = createMerkleProof(hashes, i);
      assert.equal(proof.leafIndex, i);
      assert.equal(proof.treeSize, size);
      assert.equal(proof.leafHash, hashes[i]);
      assert.equal(proof.root, merkleRoot(hashes));
      assert.equal(verifyMerkleProof(proof), true, `leaf ${i} in size ${size}`);
    }
  });
}

test('createMerkleProof rejects an empty tree and invalid leaf positions', () => {
  assert.throws(() => createMerkleProof([], 0), /at least one leaf/i);
  assert.throws(() => createMerkleProof(leaves(3), -1), /leaf index/i);
  assert.throws(() => createMerkleProof(leaves(3), 3), /leaf index/i);
  assert.throws(() => createMerkleProof(leaves(3), 1.5), /leaf index/i);
});

test('createMerkleProof rejects malformed leaf hashes', () => {
  assert.throws(
    () => createMerkleProof([sha256hex('valid'), 'not-a-sha256'], 0),
    /sha-256/i,
  );
});

test('verification rejects a changed leaf, path hash, path side, or root', () => {
  const proof = createMerkleProof(leaves(4), 1);

  const changedLeaf = cloneProof(proof);
  changedLeaf.leafHash = sha256hex('changed-leaf');
  assert.equal(verifyMerkleProof(changedLeaf), false);

  const changedPath = cloneProof(proof);
  changedPath.path[0].hash = sha256hex('changed-path');
  assert.equal(verifyMerkleProof(changedPath), false);

  const changedSide = cloneProof(proof);
  changedSide.path[0].side = changedSide.path[0].side === 'left' ? 'right' : 'left';
  assert.equal(verifyMerkleProof(changedSide), false);

  const changedRoot = cloneProof(proof);
  changedRoot.root = sha256hex('changed-root');
  assert.equal(verifyMerkleProof(changedRoot), false);
});

test('verification rejects an invalid index, tree size, and path length', () => {
  const proof = createMerkleProof(leaves(5), 4);

  const badIndex = cloneProof(proof);
  badIndex.leafIndex = 5;
  assert.equal(verifyMerkleProof(badIndex), false);

  const fractionalIndex = cloneProof(proof);
  fractionalIndex.leafIndex = 1.25;
  assert.equal(verifyMerkleProof(fractionalIndex), false);

  const badSize = cloneProof(proof);
  badSize.treeSize = 0;
  assert.equal(verifyMerkleProof(badSize), false);

  const fractionalSize = cloneProof(proof);
  fractionalSize.treeSize = 5.5;
  assert.equal(verifyMerkleProof(fractionalSize), false);

  const shortPath = cloneProof(proof);
  shortPath.path.pop();
  assert.equal(verifyMerkleProof(shortPath), false);

  const longPath = cloneProof(proof);
  longPath.path.push({ side: 'right', hash: sha256hex('extra') });
  assert.equal(verifyMerkleProof(longPath), false);
});

test('verification rejects malformed hashes and impossible path directions', () => {
  const proof = createMerkleProof(leaves(3), 2);

  const malformedLeaf = cloneProof(proof);
  malformedLeaf.leafHash = 'xyz';
  assert.equal(verifyMerkleProof(malformedLeaf), false);

  const malformedRoot = cloneProof(proof);
  malformedRoot.root = '00';
  assert.equal(verifyMerkleProof(malformedRoot), false);

  const malformedPath = cloneProof(proof);
  malformedPath.path[0].hash = 'nope';
  assert.equal(verifyMerkleProof(malformedPath), false);

  const impossibleDirection = cloneProof(proof);
  impossibleDirection.path[0].side = 'left';
  assert.equal(verifyMerkleProof(impossibleDirection), false);
});

test('single-leaf proof has an empty path and rejects any added step', () => {
  const proof = createMerkleProof(leaves(1), 0);
  assert.deepEqual(proof.path, []);
  assert.equal(verifyMerkleProof(proof), true);

  const altered = cloneProof(proof);
  altered.path.push({ side: 'right', hash: altered.leafHash });
  assert.equal(verifyMerkleProof(altered), false);
});
