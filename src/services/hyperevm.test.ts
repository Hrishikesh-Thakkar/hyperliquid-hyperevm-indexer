import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { HyperEvmService, EvmTransferMatch } from './hyperevm';

// ---------------------------------------------------------------------------
// Mock provider factory
// ---------------------------------------------------------------------------

function createMockProvider() {
  return {
    getBlockNumber: vi.fn(),
    getBlock: vi.fn(),
    send: vi.fn(),
  } as unknown as ethers.JsonRpcProvider & {
    getBlockNumber: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HyperEvmService', () => {
  let provider: ReturnType<typeof createMockProvider>;
  let service: HyperEvmService;

  beforeEach(() => {
    vi.resetAllMocks();
    provider = createMockProvider();
    service = new HyperEvmService(provider, mockLogger, 600_000);
  });

  // -----------------------------------------------------------------------
  // checkConnectivity
  // -----------------------------------------------------------------------

  describe('checkConnectivity', () => {
    it('succeeds when the RPC returns a block number', async () => {
      provider.getBlockNumber.mockResolvedValue(12345);
      await expect(service.checkConnectivity()).resolves.toBeUndefined();
      expect(provider.getBlockNumber).toHaveBeenCalledOnce();
    });

    it('throws when the RPC is unreachable', async () => {
      provider.getBlockNumber.mockRejectedValue(new Error('connection refused'));
      await expect(service.checkConnectivity()).rejects.toThrow('connection refused');
    });
  });

  // -----------------------------------------------------------------------
  // findErc20Transfers
  // -----------------------------------------------------------------------

  describe('findErc20Transfers', () => {
    const TOKEN = '0xbE6727b535545c67D5CaA73DEa6a861Ac28a3540';
    const FROM = '0x2000000000000000000000000000000000000000';
    const TO = '0x30d83d444E230F652e2c62cb5697C8DaD503987b';
    const AMOUNT = ethers.parseUnits('1.0', 18);
    const AFTER_TS = 1_700_000_000_000;

    function setupBlockRange(latestBlock: number, latestTimestamp: number) {
      provider.getBlockNumber.mockResolvedValue(latestBlock);
      // Latest block
      provider.getBlock.mockImplementation((blockNum: number) => {
        if (blockNum === latestBlock) {
          return Promise.resolve({ number: latestBlock, timestamp: latestTimestamp });
        }
        // fromBlock via binary search
        return Promise.resolve({ number: blockNum, timestamp: Math.floor(AFTER_TS / 1000) + blockNum });
      });
    }

    it('returns a match when logs contain a matching transfer', async () => {
      setupBlockRange(1000, Math.floor(AFTER_TS / 1000) + 1000);

      const matchingLog = {
        blockNumber: '0x64', // 100
        data: ethers.toBeHex(AMOUNT, 32),
        transactionHash: '0xevm-match',
        topics: [
          ethers.id('Transfer(address,address,uint256)'),
          ethers.zeroPadValue(FROM, 32),
          ethers.zeroPadValue(TO, 32),
        ],
      };

      // First eth_getLogs call returns the transfer log, rest return empty
      provider.send.mockImplementation((_method: string, params: any[]) => {
        const p = params[0];
        if (p.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
          return Promise.resolve([matchingLog]);
        }
        return Promise.resolve([]);
      });

      const result = await service.findErc20Transfers(TOKEN, FROM, TO, AMOUNT, AFTER_TS);

      expect(result).not.toBeNull();
      expect(result!.txHash).toBe('0xevm-match');
      expect(result!.amount).toBe(AMOUNT);
    });

    it('returns null when no logs match', async () => {
      setupBlockRange(1000, Math.floor(AFTER_TS / 1000) + 1000);
      provider.send.mockResolvedValue([]);

      const result = await service.findErc20Transfers(TOKEN, FROM, TO, AMOUNT, AFTER_TS);

      expect(result).toBeNull();
    });

    it('skips excluded transaction hashes', async () => {
      setupBlockRange(1000, Math.floor(AFTER_TS / 1000) + 1000);

      const log = {
        blockNumber: '0x64',
        data: ethers.toBeHex(AMOUNT, 32),
        transactionHash: '0xalready-used',
        topics: [
          ethers.id('Transfer(address,address,uint256)'),
          ethers.zeroPadValue(FROM, 32),
          ethers.zeroPadValue(TO, 32),
        ],
      };

      provider.send.mockImplementation((_method: string, params: any[]) => {
        const p = params[0];
        if (p.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
          return Promise.resolve([log]);
        }
        return Promise.resolve([]);
      });

      const result = await service.findErc20Transfers(
        TOKEN, FROM, TO, AMOUNT, AFTER_TS, undefined, new Set(['0xalready-used']),
      );

      expect(result).toBeNull();
    });

    it('ignores logs with non-matching amounts', async () => {
      setupBlockRange(1000, Math.floor(AFTER_TS / 1000) + 1000);

      const wrongAmountLog = {
        blockNumber: '0x64',
        data: ethers.toBeHex(AMOUNT + 1n, 32),
        transactionHash: '0xwrong-amount',
        topics: [
          ethers.id('Transfer(address,address,uint256)'),
          ethers.zeroPadValue(FROM, 32),
          ethers.zeroPadValue(TO, 32),
        ],
      };

      provider.send.mockImplementation((_method: string, params: any[]) => {
        const p = params[0];
        if (p.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
          return Promise.resolve([wrongAmountLog]);
        }
        return Promise.resolve([]);
      });

      const result = await service.findErc20Transfers(TOKEN, FROM, TO, AMOUNT, AFTER_TS);

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // findNativeTransfers
  // -----------------------------------------------------------------------

  describe('findNativeTransfers', () => {
    const FROM = '0x2222222222222222222222222222222222222222';
    const TO = '0x30d83d444E230F652e2c62cb5697C8DaD503987b';
    const AMOUNT = ethers.parseUnits('10.0', 18);
    const AFTER_TS = 1_700_000_000_000;

    function setupBlockRange(latestBlock: number, latestTimestamp: number) {
      provider.getBlockNumber.mockResolvedValue(latestBlock);
      provider.getBlock.mockImplementation((blockNum: number, prefetch?: boolean) => {
        if (!prefetch) {
          return Promise.resolve({ number: blockNum, timestamp: Math.floor(AFTER_TS / 1000) + blockNum });
        }
        return Promise.resolve(null); // default for prefetch — override per test
      });
    }

    it('returns a match when a block contains a matching native transfer', async () => {
      setupBlockRange(100, Math.floor(AFTER_TS / 1000) + 100);

      // Override getBlock for prefetch calls to return matching tx
      provider.getBlock.mockImplementation((blockNum: number, prefetch?: boolean) => {
        if (prefetch) {
          return Promise.resolve({
            number: blockNum,
            timestamp: Math.floor(AFTER_TS / 1000) + blockNum,
            prefetchedTransactions: [
              {
                hash: '0xnative-match',
                from: FROM,
                to: TO,
                value: AMOUNT,
              },
            ],
          });
        }
        return Promise.resolve({ number: blockNum, timestamp: Math.floor(AFTER_TS / 1000) + blockNum });
      });
      // send is used for eth_getLogs in getBlockRange, but not needed for native
      provider.send.mockResolvedValue([]);

      const result = await service.findNativeTransfers(FROM, TO, AMOUNT, AFTER_TS);

      expect(result).not.toBeNull();
      expect(result!.txHash).toBe('0xnative-match');
      expect(result!.amount).toBe(AMOUNT);
    });

    it('returns null when no blocks contain matching transfers', async () => {
      setupBlockRange(100, Math.floor(AFTER_TS / 1000) + 100);

      provider.getBlock.mockImplementation((blockNum: number, prefetch?: boolean) => {
        if (prefetch) {
          return Promise.resolve({
            number: blockNum,
            timestamp: Math.floor(AFTER_TS / 1000) + blockNum,
            prefetchedTransactions: [
              {
                hash: '0xwrong-tx',
                from: '0xOTHER',
                to: TO,
                value: AMOUNT,
              },
            ],
          });
        }
        return Promise.resolve({ number: blockNum, timestamp: Math.floor(AFTER_TS / 1000) + blockNum });
      });
      provider.send.mockResolvedValue([]);

      const result = await service.findNativeTransfers(FROM, TO, AMOUNT, AFTER_TS);

      expect(result).toBeNull();
    });

    it('skips excluded transaction hashes', async () => {
      setupBlockRange(100, Math.floor(AFTER_TS / 1000) + 100);

      provider.getBlock.mockImplementation((blockNum: number, prefetch?: boolean) => {
        if (prefetch) {
          return Promise.resolve({
            number: blockNum,
            timestamp: Math.floor(AFTER_TS / 1000) + blockNum,
            prefetchedTransactions: [
              {
                hash: '0xexcluded-hash',
                from: FROM,
                to: TO,
                value: AMOUNT,
              },
            ],
          });
        }
        return Promise.resolve({ number: blockNum, timestamp: Math.floor(AFTER_TS / 1000) + blockNum });
      });
      provider.send.mockResolvedValue([]);

      const result = await service.findNativeTransfers(
        FROM, TO, AMOUNT, AFTER_TS, undefined, new Set(['0xexcluded-hash']),
      );

      expect(result).toBeNull();
    });

    it('skips transactions with wrong value', async () => {
      setupBlockRange(100, Math.floor(AFTER_TS / 1000) + 100);

      provider.getBlock.mockImplementation((blockNum: number, prefetch?: boolean) => {
        if (prefetch) {
          return Promise.resolve({
            number: blockNum,
            timestamp: Math.floor(AFTER_TS / 1000) + blockNum,
            prefetchedTransactions: [
              {
                hash: '0xwrong-value',
                from: FROM,
                to: TO,
                value: AMOUNT + 1n,
              },
            ],
          });
        }
        return Promise.resolve({ number: blockNum, timestamp: Math.floor(AFTER_TS / 1000) + blockNum });
      });
      provider.send.mockResolvedValue([]);

      const result = await service.findNativeTransfers(FROM, TO, AMOUNT, AFTER_TS);

      expect(result).toBeNull();
    });
  });
});
