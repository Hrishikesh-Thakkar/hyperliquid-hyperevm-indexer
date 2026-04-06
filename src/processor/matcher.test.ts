import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMatcher, MatcherDeps } from './matcher';
import type { HyperEvmService } from '../services/hyperevm';
import type { TransferRepository } from '../repositories/transfer.repository';

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

function createMockDeps(): MatcherDeps & {
  evmService: { findErc20Transfers: ReturnType<typeof vi.fn>; findNativeTransfers: ReturnType<typeof vi.fn> };
  transferRepository: {
    claimForMatching: ReturnType<typeof vi.fn>;
    findUsedEvmHashes: ReturnType<typeof vi.fn>;
    markMatched: ReturnType<typeof vi.fn>;
    markRetried: ReturnType<typeof vi.fn>;
  };
} {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } as any,
    evmService: {
      findErc20Transfers: vi.fn(),
      findNativeTransfers: vi.fn(),
    } as unknown as any,
    transferRepository: {
      claimForMatching: vi.fn(),
      findUsedEvmHashes: vi.fn(),
      markMatched: vi.fn(),
      markRetried: vi.fn(),
    } as unknown as any,
    metrics: { matcherTransfersTotal: { inc: vi.fn() } } as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMatcher', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let matcher: ReturnType<typeof createMatcher>;

  beforeEach(() => {
    deps = createMockDeps();
    deps.transferRepository.findUsedEvmHashes.mockResolvedValue(new Set());
    deps.transferRepository.markMatched.mockResolvedValue(undefined);
    deps.transferRepository.markRetried.mockResolvedValue(undefined);
    matcher = createMatcher(deps);
  });

  it('returns early without touching the DB when no eligible transfers exist', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue([]);

    await matcher.run();

    expect(deps.evmService.findErc20Transfers).not.toHaveBeenCalled();
    expect(deps.evmService.findNativeTransfers).not.toHaveBeenCalled();
    expect(deps.transferRepository.markMatched).not.toHaveBeenCalled();
  });

  it('marks status=matched and stores EVM details when an ERC-20 transfer is found', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue([makeRecord()]);
    deps.evmService.findErc20Transfers.mockResolvedValue(MOCK_EVM_MATCH);

    await matcher.run();

    expect(deps.evmService.findErc20Transfers).toHaveBeenCalledTimes(1);
    expect(deps.evmService.findNativeTransfers).not.toHaveBeenCalled();
    expect(deps.transferRepository.markMatched).toHaveBeenCalledWith(
      'mock-id-001',
      '0xevm-match-hash',
      new Date(1_700_000_000_000),
      12345,
    );
  });

  it('routes to findNativeTransfers for HYPE (no evmTokenAddress)', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue(
      [makeRecord({ tokenSymbol: 'HYPE', evmTokenAddress: null })],
    );
    deps.evmService.findNativeTransfers.mockResolvedValue(MOCK_EVM_MATCH);

    await matcher.run();

    expect(deps.evmService.findNativeTransfers).toHaveBeenCalledTimes(1);
    expect(deps.evmService.findErc20Transfers).not.toHaveBeenCalled();
  });

  it('increments retryCount when no EVM match is found', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue(
      [makeRecord({ retryCount: 1 })],
    );
    deps.evmService.findErc20Transfers.mockResolvedValue(null);

    await matcher.run();

    expect(deps.transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 1);
  });

  it('calls markRetried when retryCount reaches maxRetries (exhaustion handled by repository)', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue(
      [makeRecord({ retryCount: 2 })],
    );
    deps.evmService.findErc20Transfers.mockResolvedValue(null);

    await matcher.run();

    expect(deps.transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 2);
  });

  it('force-exhausts retries immediately when the HL amount cannot be parsed (NonRetriableError)', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue(
      [makeRecord({ amount: 'not-a-number', retryCount: 0 })],
    );

    await matcher.run();

    expect(deps.evmService.findErc20Transfers).not.toHaveBeenCalled();
    expect(deps.evmService.findNativeTransfers).not.toHaveBeenCalled();
    expect(deps.transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 0, true);
  });

  it('retries normally when HyperEVM RPC throws (RetriableError)', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue([makeRecord()]);
    deps.evmService.findErc20Transfers.mockRejectedValue(new Error('connection timeout'));

    await matcher.run();

    expect(deps.transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 0, false);
  });

  it('retries normally when DB exclusion-set query fails (RetriableError)', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue([makeRecord()]);
    deps.transferRepository.findUsedEvmHashes.mockRejectedValue(new Error('DB timeout'));

    await matcher.run();

    expect(deps.transferRepository.markRetried).toHaveBeenCalledWith('mock-id-001', 0, false);
  });

  it('passes already-claimed EVM tx hashes as exclusion set to the search', async () => {
    deps.transferRepository.claimForMatching.mockResolvedValue([makeRecord()]);
    deps.transferRepository.findUsedEvmHashes.mockResolvedValue(
      new Set(['0xalready-claimed-hash']),
    );
    deps.evmService.findErc20Transfers.mockResolvedValue(null);

    await matcher.run();

    const excludeSetArg = deps.evmService.findErc20Transfers.mock.calls[0][6] as Set<string>;
    expect(excludeSetArg).toBeInstanceOf(Set);
    expect(excludeSetArg.has('0xalready-claimed-hash')).toBe(true);
  });
});
