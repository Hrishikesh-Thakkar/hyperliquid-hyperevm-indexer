import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createIndexer, IndexerDeps } from './indexer';

// ---------------------------------------------------------------------------
// Mock CursorModel — needed because indexer uses it directly
// ---------------------------------------------------------------------------

vi.mock('../models/cursor.model', () => ({
  CursorModel: {
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
}));

import { CursorModel } from '../models/cursor.model';

// ---------------------------------------------------------------------------
// Mock getBridgeTransfers
// ---------------------------------------------------------------------------

vi.mock('../services/hyperliquid', () => ({
  getBridgeTransfers: vi.fn(),
  isBridgeSend: vi.fn(),
}));

import { getBridgeTransfers } from '../services/hyperliquid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    time: 1_700_000_000_000,
    hash: '0xhl-hash-1',
    delta: {
      type: 'send',
      user: '0xsender',
      destination: '0x2000000000000000000000000000000000000000',
      token: 'UETH:0xabc',
      amount: '1.0',
      sourceDex: 'spot',
      destinationDex: 'spot',
    },
    ...overrides,
  };
}

function createMockDeps(): IndexerDeps {
  return {
    config: { wallets: ['0xwallet1'] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    hlClient: {} as any,
    tokenCache: {
      getTokenInfo: vi.fn().mockResolvedValue({
        name: 'UETH',
        evmContract: { address: '0xtoken', evm_extra_wei_decimals: 10 },
        weiDecimals: 8,
      }),
      getSystemAddress: vi.fn().mockReturnValue('0x2000000000000000000000000000000000000000'),
      getEvmDecimals: vi.fn().mockReturnValue(18),
    } as any,
    transferRepository: {
      upsertPending: vi.fn().mockResolvedValue(undefined),
    } as any,
    metrics: { indexerTransfersTotal: { inc: vi.fn() } } as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createIndexer', () => {
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.resetAllMocks();
    deps = createMockDeps();

    // Default: cursor available (not locked by another worker)
    vi.mocked(CursorModel.findOneAndUpdate).mockResolvedValue({
      wallet: '0xwallet1',
      lastProcessedTime: 0,
    });
    vi.mocked(CursorModel.updateOne).mockResolvedValue({} as any);

    // Default: no entries from HL API
    vi.mocked(getBridgeTransfers).mockResolvedValue([]);
  });

  it('processes all configured wallets', async () => {
    deps.config.wallets = ['0xwallet1', '0xwallet2'];
    const indexer = createIndexer(deps);

    await indexer.run();

    expect(CursorModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('skips wallet when cursor lock is held by another worker', async () => {
    vi.mocked(CursorModel.findOneAndUpdate).mockResolvedValue(null);
    const indexer = createIndexer(deps);

    await indexer.run();

    expect(getBridgeTransfers).not.toHaveBeenCalled();
  });

  it('calls getBridgeTransfers with correct startTime from cursor', async () => {
    vi.mocked(CursorModel.findOneAndUpdate).mockResolvedValue({
      wallet: '0xwallet1',
      lastProcessedTime: 1_700_000_000_000,
    });
    vi.mocked(getBridgeTransfers).mockResolvedValue([]);
    const indexer = createIndexer(deps);

    await indexer.run();

    expect(getBridgeTransfers).toHaveBeenCalledWith(
      deps.hlClient,
      '0xwallet1',
      1_700_000_000_001,
    );
  });

  it('upserts pending record for valid bridge entries', async () => {
    const entry = makeEntry();
    vi.mocked(getBridgeTransfers).mockResolvedValue([entry] as any);
    const indexer = createIndexer(deps);

    await indexer.run();

    expect(deps.transferRepository.upsertPending).toHaveBeenCalledWith(
      '0xhl-hash-1',
      expect.objectContaining({
        sender: '0xsender',
        status: 'pending',
        tokenSymbol: 'UETH',
      }),
    );
  });

  it('handles empty HL response without errors', async () => {
    vi.mocked(getBridgeTransfers).mockResolvedValue([]);
    const indexer = createIndexer(deps);

    await indexer.run();

    expect(deps.transferRepository.upsertPending).not.toHaveBeenCalled();
    // cursor updateOne is still called for lock release
    expect(CursorModel.updateOne).toHaveBeenCalled();
  });

  it('skips non-retriable entry and advances cursor past it', async () => {
    // Token not found → getSystemAddress returns null → NonRetriableError
    deps.tokenCache.getSystemAddress = vi.fn().mockReturnValue(null);
    const entry = makeEntry({ time: 1_700_000_000_100 });
    vi.mocked(getBridgeTransfers).mockResolvedValue([entry] as any);
    const indexer = createIndexer(deps);

    await indexer.run();

    // Cursor should still advance past the bad entry
    expect(CursorModel.updateOne).toHaveBeenCalledWith(
      { wallet: '0xwallet1' },
      { lastProcessedTime: 1_700_000_000_100 },
    );
    expect(deps.metrics.indexerTransfersTotal.inc).toHaveBeenCalledWith({ result: 'skipped' });
  });

  it('stops batch on retriable error and preserves cursor', async () => {
    // Token lookup fails (network error) → RetriableError
    deps.tokenCache.getTokenInfo = vi.fn().mockRejectedValue(new Error('network timeout'));
    const entry = makeEntry({ time: 1_700_000_000_100 });
    vi.mocked(getBridgeTransfers).mockResolvedValue([entry] as any);
    const indexer = createIndexer(deps);

    await indexer.run();

    // Cursor should NOT advance (lastProcessedTime stays at 0 which is not > 0)
    expect(CursorModel.updateOne).not.toHaveBeenCalledWith(
      { wallet: '0xwallet1' },
      expect.objectContaining({ lastProcessedTime: 1_700_000_000_100 }),
    );
    expect(deps.metrics.indexerTransfersTotal.inc).toHaveBeenCalledWith({ result: 'retriable' });
  });

  it('releases wallet lock even when processing throws', async () => {
    vi.mocked(getBridgeTransfers).mockRejectedValue(new Error('boom'));
    const indexer = createIndexer(deps);

    await indexer.run();

    // Lock release on the cursor
    expect(CursorModel.updateOne).toHaveBeenCalledWith(
      { wallet: '0xwallet1' },
      { $set: { lockedUntil: null } },
    );
  });
});
