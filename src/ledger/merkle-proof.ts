/**
 * merkle-proof.ts — compact inclusion proofs for Mattermark's ledger tree.
 *
 * This module deliberately matches hashchain.ts exactly. Mattermark's existing
 * Merkle root duplicates the final node whenever a level has odd cardinality;
 * importing a Certificate Transparency proof algorithm unchanged would produce
 * different roots. Proofs therefore carry an explicit left/right path and the
 * verifier also reconstructs the only path shape valid for (index, treeSize).
 */

import { sha256hex } from './hashchain.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface MerkleProofStep {
  side: 'left' | 'right';
  hash: string;
}

export interface MerkleInclusionProof {
  leafIndex: number;
  treeSize: number;
  leafHash: string;
  root: string;
  path: MerkleProofStep[];
}

function assertHash(hash: string, label: string): void {
  if (!SHA256_HEX.test(hash)) {
    throw new Error(`${label} must be a lowercase 32-byte SHA-256 hex string`);
  }
}

function parent(left: string, right: string): string {
  return sha256hex(left + right);
}

/**
 * Build an inclusion proof over the same duplicate-last tree used by
 * hashchain.merkleRoot(). The input values are already event hashes, so they
 * are tree leaves directly rather than being re-hashed with a prefix.
 */
export function createMerkleProof(hashes: string[], leafIndex: number): MerkleInclusionProof {
  if (hashes.length === 0) throw new Error('Merkle proof needs at least one leaf');
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= hashes.length) {
    throw new Error(`leaf index ${leafIndex} is outside a ${hashes.length}-leaf tree`);
  }
  hashes.forEach((hash, i) => assertHash(hash, `leaf ${i}`));

  let level = hashes.slice();
  let index = leafIndex;
  const path: MerkleProofStep[] = [];

  while (level.length > 1) {
    const isRightChild = index % 2 === 1;
    const siblingIndex = isRightChild ? index - 1 : index + 1;
    const sibling = level[siblingIndex] ?? level[index];
    path.push({ side: isRightChild ? 'left' : 'right', hash: sibling });

    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(parent(level[i], level[i + 1] ?? level[i]));
    }
    level = next;
    index = Math.floor(index / 2);
  }

  return {
    leafIndex,
    treeSize: hashes.length,
    leafHash: hashes[leafIndex],
    root: level[0],
    path,
  };
}

/**
 * Verify both the hashes and the path geometry. Checking geometry matters: a
 * proof for an odd duplicate node has a uniquely determined self-sibling, and
 * accepting arbitrary directions would turn malformed evidence into a merely
 * different tree instead of rejecting it.
 */
export function verifyMerkleProof(proof: MerkleInclusionProof): boolean {
  try {
    if (!proof || typeof proof !== 'object') return false;
    if (!Number.isInteger(proof.treeSize) || proof.treeSize < 1) return false;
    if (
      !Number.isInteger(proof.leafIndex) ||
      proof.leafIndex < 0 ||
      proof.leafIndex >= proof.treeSize
    ) {
      return false;
    }
    if (!Array.isArray(proof.path)) return false;
    assertHash(proof.leafHash, 'leaf hash');
    assertHash(proof.root, 'root');

    let expectedLevels = 0;
    for (let size = proof.treeSize; size > 1; size = Math.ceil(size / 2)) {
      expectedLevels += 1;
    }
    if (proof.path.length !== expectedLevels) return false;

    let current = proof.leafHash;
    let index = proof.leafIndex;
    let size = proof.treeSize;

    for (const step of proof.path) {
      if (!step || typeof step !== 'object') return false;
      if (step.side !== 'left' && step.side !== 'right') return false;
      assertHash(step.hash, 'path hash');

      const expectedSide: MerkleProofStep['side'] = index % 2 === 1 ? 'left' : 'right';
      if (step.side !== expectedSide) return false;

      // The final unpaired node is duplicated by hashchain.merkleRoot(). Its
      // proof sibling must therefore be the node computed so far, not an
      // arbitrary value supplied by the bundle.
      const isDuplicatedOddNode = index % 2 === 0 && index + 1 >= size;
      if (isDuplicatedOddNode && step.hash !== current) return false;

      current = step.side === 'left'
        ? parent(step.hash, current)
        : parent(current, step.hash);
      index = Math.floor(index / 2);
      size = Math.ceil(size / 2);
    }

    return size === 1 && index === 0 && current === proof.root;
  } catch {
    return false;
  }
}
