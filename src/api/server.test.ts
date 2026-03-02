import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock mongoose so the health check can test disconnected/connected states
// without a real MongoDB.
// vi.hoisted is required because vi.mock factories are hoisted before imports.
// ---------------------------------------------------------------------------

const mockConnection = vi.hoisted(() => ({ readyState: 1 as number }));

vi.mock('mongoose', () => ({
  default: { connection: mockConnection },
}));

// Mock TransferModel so route handlers never touch a real database
vi.mock('../models/transfer.model', () => ({
  TransferModel: {
    find: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

import { buildServer } from './server';
import { TransferModel } from '../models/transfer.model';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_TRANSFER = {
  // MongoDB internals — should be stripped from API responses
  _id: 'abc123',
  __v: 0,
  createdAt: new Date('2024-01-01').toISOString(),
  updatedAt: new Date('2024-01-01').toISOString(),
  // Internal bookkeeping — should be stripped from API responses
  retryCount: 0,
  lastRetryAt: null,
  decimals: 18,
  // Public fields
  hlTxHash: '0xhl-hash-001',
  evmTxHash: '0xevm-hash-001',
  sender: '0x30d83d444e230f652e2c62cb5697c8dad503987b',
  receiver: '0x30d83d444e230f652e2c62cb5697c8dad503987b',
  evmFrom: '0x2020000000000000000000000000000000000042',
  hlToken: 'UETH:0xe1edd30daaf5caac3fe63569e24748da',
  evmTokenAddress: '0xbe6727b535545c67d5caa73dea6a861ac28a3540',
  tokenSymbol: 'UETH',
  amount: '1.0',
  status: 'matched',
  hlTimestamp: new Date('2024-01-01').toISOString(),
  evmTimestamp: new Date('2024-01-01T00:00:05Z').toISOString(),
  evmBlockNumber: 1234567,
};

// ---------------------------------------------------------------------------
// Helpers to build mock query chains
// ---------------------------------------------------------------------------

function mockFindChain(results: unknown[]): unknown {
  const lean = vi.fn().mockResolvedValue(results);
  const limit = vi.fn().mockReturnValue({ lean });
  const skip = vi.fn().mockReturnValue({ limit });
  const sort = vi.fn().mockReturnValue({ skip });
  return { sort };
}

function mockFindOneChain(result: unknown): unknown {
  return { lean: vi.fn().mockResolvedValue(result) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer();
    mockConnection.readyState = 1;
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with status=ok when the DB is connected', async () => {
    mockConnection.readyState = 1;

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; db: string }>();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
    expect(body).toHaveProperty('timestamp');
  });

  it('returns 503 with status=degraded when the DB is disconnected', async () => {
    mockConnection.readyState = 0;

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json<{ status: string; db: string }>();
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('disconnected');
  });
});

describe('GET /transfers/:wallet', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns paginated transfer list and total count', async () => {
    vi.mocked(TransferModel.find).mockReturnValue(mockFindChain([MOCK_TRANSFER]) as never);
    vi.mocked(TransferModel.countDocuments).mockResolvedValue(1 as never);

    const res = await app.inject({
      method: 'GET',
      url: '/transfers/0x30d83d444E230F652e2c62cb5697C8DaD503987b',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; transfers: Record<string, unknown>[] }>();
    expect(body.total).toBe(1);
    expect(body.transfers).toHaveLength(1);
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');

    const transfer = body.transfers[0];
    // Explorer URLs must be present
    expect(transfer.hypercoreTxUrl).toBe('https://www.flowscan.xyz/tx/0xhl-hash-001');
    expect(transfer.evmTxUrl).toBe('https://hyperevmscan.io/tx/0xevm-hash-001');
    // MongoDB / bookkeeping fields must be absent
    expect(transfer).not.toHaveProperty('_id');
    expect(transfer).not.toHaveProperty('__v');
    expect(transfer).not.toHaveProperty('createdAt');
    expect(transfer).not.toHaveProperty('updatedAt');
    expect(transfer).not.toHaveProperty('retryCount');
    expect(transfer).not.toHaveProperty('lastRetryAt');
  });

  it('forwards the status query param as a DB filter', async () => {
    vi.mocked(TransferModel.find).mockReturnValue(mockFindChain([]) as never);
    vi.mocked(TransferModel.countDocuments).mockResolvedValue(0 as never);

    await app.inject({
      method: 'GET',
      url: '/transfers/0x30d83d444E230F652e2c62cb5697C8DaD503987b?status=pending',
    });

    const filterArg = vi.mocked(TransferModel.find).mock.calls[0][0] as Record<string, unknown>;
    expect(filterArg).toMatchObject({ status: 'pending' });
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/transfers/0x30d83d444E230F652e2c62cb5697C8DaD503987b?status=unknown',
    });
    expect(res.statusCode).toBe(400);
  });

  it('normalises the wallet address to lowercase before querying', async () => {
    vi.mocked(TransferModel.find).mockReturnValue(mockFindChain([]) as never);
    vi.mocked(TransferModel.countDocuments).mockResolvedValue(0 as never);

    await app.inject({
      method: 'GET',
      url: '/transfers/0x30D83D444E230F652E2C62CB5697C8DAD503987B', // uppercase
    });

    const filterArg = vi.mocked(TransferModel.find).mock.calls[0][0] as {
      $or: Array<Record<string, string>>;
    };
    // Both sender/receiver checks should use lowercased address
    expect(filterArg.$or[0].sender).toBe('0x30d83d444e230f652e2c62cb5697c8dad503987b');
  });
});

describe('GET /transfers/tx/:hash', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the transfer when found by hlTxHash or evmTxHash', async () => {
    vi.mocked(TransferModel.findOne).mockReturnValue(
      mockFindOneChain(MOCK_TRANSFER) as never,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/transfers/tx/0xhl-hash-001',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.hlTxHash).toBe('0xhl-hash-001');
    expect(body.hypercoreTxUrl).toBe('https://www.flowscan.xyz/tx/0xhl-hash-001');
    expect(body.evmTxUrl).toBe('https://hyperevmscan.io/tx/0xevm-hash-001');
    expect(body).not.toHaveProperty('_id');
    expect(body).not.toHaveProperty('retryCount');
  });

  it('evmTxUrl is null when the transfer is still pending', async () => {
    vi.mocked(TransferModel.findOne).mockReturnValue(
      mockFindOneChain({ ...MOCK_TRANSFER, evmTxHash: null, status: 'pending' }) as never,
    );

    const res = await app.inject({ method: 'GET', url: '/transfers/tx/0xhl-hash-001' });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.evmTxUrl).toBeNull();
    // hypercoreTxUrl is always present
    expect(body.hypercoreTxUrl).toBe('https://www.flowscan.xyz/tx/0xhl-hash-001');
  });

  it('returns 404 when no transfer matches the hash', async () => {
    vi.mocked(TransferModel.findOne).mockReturnValue(mockFindOneChain(null) as never);

    const res = await app.inject({
      method: 'GET',
      url: '/transfers/tx/0xnonexistent',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/not found/i);
  });
});
