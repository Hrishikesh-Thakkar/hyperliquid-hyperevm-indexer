import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports so vitest hoists them correctly
// ---------------------------------------------------------------------------

vi.mock('../models/transfer.model', () => ({
  TransferModel: {
    find: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../services/hyperevm', () => ({
  findErc20Transfers: vi.fn(),
  findNativeTransfers: vi.fn(),
}));

vi.mock('../config', () => ({
  config: {
    maxRetries: 3,
    retryDelayMs: 120_000,
    evmSearchWindowMs: 600_000,
  },
}));

import { runMatcher } from './matcher';
import { TransferModel } from '../models/transfer.model';
import { findErc20Transfers, findNativeTransfers } from '../services/hyperevm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal mock TransferRecord that satisfies runMatcher's queries */
function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'mock-id-001',
    hlTxHash: '0xhl-hash',
    amount: '1.0',
    decimals: 18,
    evmFrom: '0x2020000000000000000000000000000000000001',
    receiver: '0xrecipient0000000000000000000000000000000',
    tokenSymbol: 'UETH',
    evmTokenAddress: '0xtoken0000000000000000000000000000000000',
    hlTimestamp: new Date('2024-01-01T00:00:00Z'),
    retryCount: 0,
    status: 'pending',
    lastRetryAt: null,
    ...overrides,
  };
}

const MOCK_EVM_MATCH = {
  txHash: '0xevm-match-hash',
  blockNumber: 12345,
  timestamp: 1_700_000_000_000,
  from: '0x2020000000000000000000000000000000000001',
  to: '0xrecipient0000000000000000000000000000000',
  amount: 1_000_000_000_000_000_000n,
};

/** Configures TransferModel.find to return `records` for the eligibility query
 *  and an empty array for the exclusion-set query. */
function mockEligible(records: ReturnType<typeof makeRecord>[]): void {
  vi.mocked(TransferModel.find)
    .mockReturnValueOnce({
      sort: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(records) }),
    } as never)
    .mockReturnValueOnce({ distinct: vi.fn().mockResolvedValue([]) } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMatcher', () => {
  beforeEach(() => {
    // resetAllMocks clears call history AND flushes any unconsumed mockReturnValueOnce
    // queues from previous tests, preventing state leakage between tests.
    vi.resetAllMocks();
    vi.mocked(TransferModel.updateOne).mockResolvedValue({} as never);
  });

  it('returns early without touching the DB when no eligible transfers exist', async () => {
    vi.mocked(TransferModel.find).mockReturnValueOnce({
      sort: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
    } as never);

    await runMatcher();

    expect(findErc20Transfers).not.toHaveBeenCalled();
    expect(findNativeTransfers).not.toHaveBeenCalled();
    expect(TransferModel.updateOne).not.toHaveBeenCalled();
  });

  it('marks status=matched and stores EVM details when an ERC-20 transfer is found', async () => {
    mockEligible([makeRecord()]);
    vi.mocked(findErc20Transfers).mockResolvedValue(MOCK_EVM_MATCH);

    await runMatcher();

    expect(findErc20Transfers).toHaveBeenCalledTimes(1);
    expect(findNativeTransfers).not.toHaveBeenCalled();

    expect(TransferModel.updateOne).toHaveBeenCalledWith(
      { _id: 'mock-id-001' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'matched',
          evmTxHash: '0xevm-match-hash',
          evmBlockNumber: 12345,
        }),
      }),
    );
  });

  it('routes to findNativeTransfers for HYPE (no evmTokenAddress)', async () => {
    mockEligible([makeRecord({ tokenSymbol: 'HYPE', evmTokenAddress: null })]);
    // Provide a second distinct mock for the exclusion query
    vi.mocked(findNativeTransfers).mockResolvedValue(MOCK_EVM_MATCH);

    await runMatcher();

    expect(findNativeTransfers).toHaveBeenCalledTimes(1);
    expect(findErc20Transfers).not.toHaveBeenCalled();
  });

  it('increments retryCount when no EVM match is found', async () => {
    mockEligible([makeRecord({ retryCount: 1 })]);
    vi.mocked(findErc20Transfers).mockResolvedValue(null);

    await runMatcher();

    expect(TransferModel.updateOne).toHaveBeenCalledWith(
      { _id: 'mock-id-001' },
      expect.objectContaining({
        $set: expect.objectContaining({
          retryCount: 2,
        }),
      }),
    );
    // status should NOT be changed to failed yet (retryCount 2 < maxRetries 3)
    const setPayload = vi.mocked(TransferModel.updateOne).mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(setPayload.$set.status).toBeUndefined();
  });

  it('sets status=failed when retryCount reaches maxRetries', async () => {
    // retryCount is already at maxRetries - 1; next attempt should exhaust
    mockEligible([makeRecord({ retryCount: 2 })]);
    vi.mocked(findErc20Transfers).mockResolvedValue(null);

    await runMatcher();

    expect(TransferModel.updateOne).toHaveBeenCalledWith(
      { _id: 'mock-id-001' },
      expect.objectContaining({
        $set: expect.objectContaining({
          retryCount: 3,
          status: 'failed',
        }),
      }),
    );
  });

  it('force-exhausts retries immediately when the HL amount cannot be parsed', async () => {
    // 'not-a-number' will cause ethers.parseUnits to throw
    mockEligible([makeRecord({ amount: 'not-a-number', retryCount: 0 })]);

    await runMatcher();

    // The EVM search should never be attempted
    expect(findErc20Transfers).not.toHaveBeenCalled();
    expect(findNativeTransfers).not.toHaveBeenCalled();

    // The record should be immediately marked failed
    expect(TransferModel.updateOne).toHaveBeenCalledWith(
      { _id: 'mock-id-001' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
        }),
      }),
    );
  });

  it('passes already-claimed EVM tx hashes as exclusion set to the search', async () => {
    const record = makeRecord();

    vi.mocked(TransferModel.find)
      .mockReturnValueOnce({
        sort: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([record]) }),
      } as never)
      .mockReturnValueOnce({
        distinct: vi.fn().mockResolvedValue(['0xalready-claimed-hash']),
      } as never);

    vi.mocked(findErc20Transfers).mockResolvedValue(null);

    await runMatcher();

    const excludeSetArg = vi.mocked(findErc20Transfers).mock.calls[0][6] as Set<string>;
    expect(excludeSetArg).toBeInstanceOf(Set);
    expect(excludeSetArg.has('0xalready-claimed-hash')).toBe(true);
  });
});
