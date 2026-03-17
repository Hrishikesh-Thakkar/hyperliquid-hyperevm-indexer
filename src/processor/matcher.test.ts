import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports so vitest hoists them correctly
// ---------------------------------------------------------------------------

vi.mock('../repositories/transfer.repository', () => ({
  transferRepository: {
    claimForMatching: vi.fn(),
    findUsedEvmHashes: vi.fn(),
    markMatched: vi.fn(),
    markRetried: vi.fn(),
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

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../metrics', () => ({
  matcherTransfersTotal: { inc: vi.fn() },
}));

import { runMatcher } from './matcher';
import { transferRepository } from '../repositories/transfer.repository';
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
    nextRetryAt: null,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMatcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(transferRepository.findUsedEvmHashes).mockResolvedValue(new Set());
    vi.mocked(transferRepository.markMatched).mockResolvedValue();
    vi.mocked(transferRepository.markRetried).mockResolvedValue();
  });

  it('returns early without touching the DB when no eligible transfers exist', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue([]);

    await runMatcher();

    expect(findErc20Transfers).not.toHaveBeenCalled();
    expect(findNativeTransfers).not.toHaveBeenCalled();
    expect(transferRepository.markMatched).not.toHaveBeenCalled();
  });

  it('marks status=matched and stores EVM details when an ERC-20 transfer is found', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue([makeRecord()] as never);
    vi.mocked(findErc20Transfers).mockResolvedValue(MOCK_EVM_MATCH);

    await runMatcher();

    expect(findErc20Transfers).toHaveBeenCalledTimes(1);
    expect(findNativeTransfers).not.toHaveBeenCalled();
    expect(transferRepository.markMatched).toHaveBeenCalledWith(
      'mock-id-001',
      '0xevm-match-hash',
      new Date(1_700_000_000_000),
      12345,
    );
  });

  it('routes to findNativeTransfers for HYPE (no evmTokenAddress)', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue(
      [makeRecord({ tokenSymbol: 'HYPE', evmTokenAddress: null })] as never,
    );
    vi.mocked(findNativeTransfers).mockResolvedValue(MOCK_EVM_MATCH);

    await runMatcher();

    expect(findNativeTransfers).toHaveBeenCalledTimes(1);
    expect(findErc20Transfers).not.toHaveBeenCalled();
  });

  it('increments retryCount when no EVM match is found', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue(
      [makeRecord({ retryCount: 1 })] as never,
    );
    vi.mocked(findErc20Transfers).mockResolvedValue(null);

    await runMatcher();

    expect(transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 1);
  });

  it('calls markRetried when retryCount reaches maxRetries (exhaustion handled by repository)', async () => {
    // retryCount is already at maxRetries - 1; the repository will mark it failed
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue(
      [makeRecord({ retryCount: 2 })] as never,
    );
    vi.mocked(findErc20Transfers).mockResolvedValue(null);

    await runMatcher();

    expect(transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 2);
  });

  it('force-exhausts retries immediately when the HL amount cannot be parsed (NonRetriableError)', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue(
      [makeRecord({ amount: 'not-a-number', retryCount: 0 })] as never,
    );

    await runMatcher();

    expect(findErc20Transfers).not.toHaveBeenCalled();
    expect(findNativeTransfers).not.toHaveBeenCalled();
    // forceExhaust=true because NonRetriableError — bad amount will never parse
    expect(transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 0, true);
  });

  it('retries normally when HyperEVM RPC throws (RetriableError)', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue([makeRecord()] as never);
    vi.mocked(findErc20Transfers).mockRejectedValue(new Error('connection timeout'));

    await runMatcher();

    // forceExhaust=false — RPC failure is transient
    expect(transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 0, false);
  });

  it('retries normally when DB exclusion-set query fails (RetriableError)', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue([makeRecord()] as never);
    vi.mocked(transferRepository.findUsedEvmHashes).mockRejectedValue(new Error('DB timeout'));

    await runMatcher();

    expect(transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 0, false);
  });

  it('passes already-claimed EVM tx hashes as exclusion set to the search', async () => {
    vi.mocked(transferRepository.claimForMatching).mockResolvedValue([makeRecord()] as never);
    vi.mocked(transferRepository.findUsedEvmHashes).mockResolvedValue(
      new Set(['0xalready-claimed-hash']),
    );
    vi.mocked(findErc20Transfers).mockResolvedValue(null);

    await runMatcher();

    const excludeSetArg = vi.mocked(findErc20Transfers).mock.calls[0][6] as Set<string>;
    expect(excludeSetArg).toBeInstanceOf(Set);
    expect(excludeSetArg.has('0xalready-claimed-hash')).toBe(true);
  });
});
