/**
 * Integration tests for the REST API against a real MongoDB instance.
 *
 * Verifies the full path: HTTP request → route handler → MongoDB query → serialised response.
 * No mocks — only the external blockchain APIs are absent.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock the processor state (since we don't start the processor in API integration tests)
vi.mock('../../src/processor', () => ({
  processorState: {
    indexerLastRunAt: null,
    indexerLastError: null,
    matcherLastRunAt: null,
    matcherLastError: null,
  },
}));
vi.mock('../../src/metrics', () => ({
  metricsRegistry: {
    metrics: vi.fn().mockResolvedValue('# HELP fake\n'),
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  },
}));

import { setupMongo, teardownMongo, clearCollections } from './setup';
import { TransferModel } from '../../src/models/transfer.model';
import { buildServer } from '../../src/api/server';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  await setupMongo();
  app = buildServer();
}, 30_000);

afterAll(async () => {
  await app.close();
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
    sender: '0xwallet1',
    receiver: '0xwallet1',
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

describe('API integration', () => {
  describe('GET /health', () => {
    it('returns 200 with ok status when MongoDB is connected', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.db).toBe('connected');
    });
  });

  describe('GET /transfers/:wallet', () => {
    it('returns transfers for a wallet with pagination metadata', async () => {
      await insertTransfer({ sender: '0xwallet1', receiver: '0xwallet1' });
      await insertTransfer({ sender: '0xwallet1', receiver: '0xwallet1' });
      await insertTransfer({ sender: '0xother', receiver: '0xother' });

      const res = await app.inject({ method: 'GET', url: '/transfers/0xwallet1' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.transfers).toHaveLength(2);
      expect(body).toHaveProperty('limit');
      expect(body).toHaveProperty('offset');
    });

    it('filters by status query parameter', async () => {
      await insertTransfer({ sender: '0xwallet1', status: 'pending' });
      await insertTransfer({ sender: '0xwallet1', status: 'matched', evmTxHash: '0xevm1' });

      const res = await app.inject({
        method: 'GET',
        url: '/transfers/0xwallet1?status=matched',
      });

      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.transfers[0].status).toBe('matched');
    });

    it('strips internal fields from the response', async () => {
      await insertTransfer({ sender: '0xwallet1' });

      const res = await app.inject({ method: 'GET', url: '/transfers/0xwallet1' });

      const transfer = res.json().transfers[0];
      expect(transfer).not.toHaveProperty('_id');
      expect(transfer).not.toHaveProperty('__v');
      expect(transfer).not.toHaveProperty('retryCount');
      expect(transfer).not.toHaveProperty('lastRetryAt');
      expect(transfer).not.toHaveProperty('nextRetryAt');
    });

    it('includes explorer URLs in the response', async () => {
      await insertTransfer({
        sender: '0xwallet1',
        hlTxHash: '0xhl-abc',
        evmTxHash: '0xevm-abc',
        status: 'matched',
      });

      const res = await app.inject({ method: 'GET', url: '/transfers/0xwallet1' });

      const transfer = res.json().transfers[0];
      expect(transfer.hypercoreTxUrl).toContain('0xhl-abc');
      expect(transfer.evmTxUrl).toContain('0xevm-abc');
    });

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await insertTransfer({
          sender: '0xwallet1',
          hlTimestamp: new Date(2024, 0, i + 1),
        });
      }

      const res = await app.inject({
        method: 'GET',
        url: '/transfers/0xwallet1?limit=2&offset=2',
      });

      const body = res.json();
      expect(body.total).toBe(5);
      expect(body.transfers).toHaveLength(2);
      expect(body.offset).toBe(2);
      expect(body.limit).toBe(2);
    });
  });

  describe('GET /transfers/tx/:hash', () => {
    it('finds a transfer by hlTxHash', async () => {
      await insertTransfer({ hlTxHash: '0xfind-by-hl' });

      const res = await app.inject({ method: 'GET', url: '/transfers/tx/0xfind-by-hl' });

      expect(res.statusCode).toBe(200);
      expect(res.json().hlTxHash).toBe('0xfind-by-hl');
    });

    it('finds a transfer by evmTxHash', async () => {
      await insertTransfer({ hlTxHash: '0xunique1', evmTxHash: '0xfind-by-evm', status: 'matched' });

      const res = await app.inject({ method: 'GET', url: '/transfers/tx/0xfind-by-evm' });

      expect(res.statusCode).toBe(200);
      expect(res.json().evmTxHash).toBe('0xfind-by-evm');
    });

    it('returns 404 when hash is not found', async () => {
      const res = await app.inject({ method: 'GET', url: '/transfers/tx/0xnonexistent' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /metrics', () => {
    it('returns Prometheus-format text', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
    });
  });
});
