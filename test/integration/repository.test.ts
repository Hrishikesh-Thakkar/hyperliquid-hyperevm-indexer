/**
 * Integration tests for TransferRepository against a real MongoDB instance.
 *
 * These tests verify that queries, indexes, and atomic operations work
 * correctly with an actual database — no mocks.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupMongo, teardownMongo, clearCollections } from './setup';
import { TransferModel } from '../../src/models/transfer.model';
import { TransferRepository } from '../../src/repositories/transfer.repository';

const repo = new TransferRepository();

beforeAll(async () => {
  await setupMongo();
}, 30_000);

afterAll(async () => {
  await teardownMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertTransfer(overrides: Record<string, unknown> = {}) {
  return TransferModel.create({
    hlTxHash: `0x${Math.random().toString(16).slice(2, 18)}`,
    sender: '0xsender',
    receiver: '0xreceiver',
    evmFrom: '0xevmfrom',
    hlToken: 'UETH:0xabc',
    evmTokenAddress: '0xtokenaddr',
    tokenSymbol: 'UETH',
    amount: '1.0',
    decimals: 18,
    hlTimestamp: new Date('2024-01-01'),
    status: 'pending',
    retryCount: 0,
    lastRetryAt: null,
    nextRetryAt: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransferRepository (integration)', () => {
  describe('upsertPending', () => {
    it('inserts a new record when hlTxHash does not exist', async () => {
      await repo.upsertPending('0xnew-hash', {
        sender: '0xsender',
        receiver: '0xreceiver',
        evmFrom: '0xevmfrom',
        hlToken: 'UETH:0xabc',
        tokenSymbol: 'UETH',
        amount: '1.0',
        decimals: 18,
        hlTimestamp: new Date(),
        status: 'pending',
        retryCount: 0,
      });

      const doc = await TransferModel.findOne({ hlTxHash: '0xnew-hash' });
      expect(doc).not.toBeNull();
      expect(doc!.status).toBe('pending');
    });

    it('does NOT overwrite an existing matched record', async () => {
      await insertTransfer({ hlTxHash: '0xexisting', status: 'matched', evmTxHash: '0xevm123' });

      // Try to upsert the same hlTxHash — should be a no-op
      await repo.upsertPending('0xexisting', {
        sender: '0xsender',
        receiver: '0xreceiver',
        evmFrom: '0xevmfrom',
        hlToken: 'UETH:0xabc',
        tokenSymbol: 'UETH',
        amount: '999.0', // different amount
        decimals: 18,
        hlTimestamp: new Date(),
        status: 'pending',
        retryCount: 0,
      });

      const doc = await TransferModel.findOne({ hlTxHash: '0xexisting' });
      expect(doc!.status).toBe('matched');
      expect(doc!.amount).toBe('1.0'); // original amount preserved
    });
  });

  describe('claimForMatching', () => {
    it('returns eligible pending records ordered by retryCount then hlTimestamp', async () => {
      await insertTransfer({ hlTxHash: '0xold', hlTimestamp: new Date('2024-01-01'), retryCount: 0 });
      await insertTransfer({ hlTxHash: '0xnew', hlTimestamp: new Date('2024-06-01'), retryCount: 0 });
      await insertTransfer({ hlTxHash: '0xretried', hlTimestamp: new Date('2024-01-01'), retryCount: 1 });

      const claimed = await repo.claimForMatching(10);

      expect(claimed).toHaveLength(3);
      // retryCount=0 first (2 records), then retryCount=1
      expect(claimed[0].hlTxHash).toBe('0xold');
      expect(claimed[1].hlTxHash).toBe('0xnew');
      expect(claimed[2].hlTxHash).toBe('0xretried');
    });

    it('skips records with nextRetryAt in the future', async () => {
      await insertTransfer({
        hlTxHash: '0xlocked',
        nextRetryAt: new Date(Date.now() + 60_000), // locked for 60s
      });
      await insertTransfer({ hlTxHash: '0xfree', nextRetryAt: null });

      const claimed = await repo.claimForMatching(10);

      expect(claimed).toHaveLength(1);
      expect(claimed[0].hlTxHash).toBe('0xfree');
    });

    it('skips records with status !== pending', async () => {
      await insertTransfer({ hlTxHash: '0xmatched', status: 'matched' });
      await insertTransfer({ hlTxHash: '0xfailed', status: 'failed' });
      await insertTransfer({ hlTxHash: '0xpending', status: 'pending' });

      const claimed = await repo.claimForMatching(10);

      expect(claimed).toHaveLength(1);
      expect(claimed[0].hlTxHash).toBe('0xpending');
    });

    it('sets nextRetryAt in the future as a soft lock', async () => {
      await insertTransfer({ hlTxHash: '0xtest' });

      const claimed = await repo.claimForMatching(1);

      expect(claimed).toHaveLength(1);
      expect(claimed[0].nextRetryAt).not.toBeNull();
      expect(claimed[0].nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('prevents two concurrent claims on the same record', async () => {
      await insertTransfer({ hlTxHash: '0xrace' });

      // First claim succeeds
      const first = await repo.claimForMatching(1);
      // Second claim finds nothing (soft lock in effect)
      const second = await repo.claimForMatching(1);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });
  });

  describe('markMatched', () => {
    it('updates status and EVM fields', async () => {
      const doc = await insertTransfer({ hlTxHash: '0xmark-test' });

      await repo.markMatched(doc._id, '0xevm-hash', new Date('2024-06-01'), 12345);

      const updated = await TransferModel.findById(doc._id);
      expect(updated!.status).toBe('matched');
      expect(updated!.evmTxHash).toBe('0xevm-hash');
      expect(updated!.evmBlockNumber).toBe(12345);
    });
  });

  describe('markRetried', () => {
    it('increments retryCount and sets exponential nextRetryAt', async () => {
      const doc = await insertTransfer({ hlTxHash: '0xretry-test', retryCount: 0 });

      await repo.markRetried(doc._id, 0);

      const updated = await TransferModel.findById(doc._id);
      expect(updated!.retryCount).toBe(1);
      expect(updated!.status).toBe('pending'); // not exhausted yet
      expect(updated!.nextRetryAt).not.toBeNull();
      expect(updated!.lastRetryAt).not.toBeNull();
    });

    it('marks as failed when forceExhaust is true', async () => {
      const doc = await insertTransfer({ hlTxHash: '0xexhaust-test', retryCount: 0 });

      await repo.markRetried(doc._id, 0, true);

      const updated = await TransferModel.findById(doc._id);
      expect(updated!.status).toBe('failed');
      expect(updated!.retryCount).toBe(1);
      expect(updated!.nextRetryAt).toBeNull(); // no future retry
    });
  });

  describe('countByStatus', () => {
    it('returns correct counts grouped by status', async () => {
      await insertTransfer({ status: 'pending' });
      await insertTransfer({ status: 'pending' });
      await insertTransfer({ status: 'matched', evmTxHash: '0xa' });
      await insertTransfer({ status: 'failed' });

      const counts = await repo.countByStatus();

      expect(counts).toEqual({ pending: 2, matched: 1, failed: 1 });
    });

    it('returns zeros when the collection is empty', async () => {
      const counts = await repo.countByStatus();
      expect(counts).toEqual({ pending: 0, matched: 0, failed: 0 });
    });
  });

  describe('findUsedEvmHashes', () => {
    it('returns hashes from sibling records with the same fingerprint', async () => {
      const target = await insertTransfer({
        hlTxHash: '0xtarget',
        evmFrom: '0xbridge',
        receiver: '0xreceiver',
        amount: '1.0',
        tokenSymbol: 'UETH',
      });

      // Sibling with same fingerprint and a claimed evmTxHash
      await insertTransfer({
        hlTxHash: '0xsibling',
        evmFrom: '0xbridge',
        receiver: '0xreceiver',
        amount: '1.0',
        tokenSymbol: 'UETH',
        evmTxHash: '0xclaimed-evm-hash',
        status: 'matched',
      });

      // Different token — should NOT be in the exclusion set
      await insertTransfer({
        hlTxHash: '0xdifferent',
        evmFrom: '0xbridge',
        receiver: '0xreceiver',
        amount: '1.0',
        tokenSymbol: 'HYPE',
        evmTxHash: '0xother-hash',
        status: 'matched',
      });

      const used = await repo.findUsedEvmHashes(target);

      expect(used.size).toBe(1);
      expect(used.has('0xclaimed-evm-hash')).toBe(true);
      expect(used.has('0xother-hash')).toBe(false);
    });
  });
});
