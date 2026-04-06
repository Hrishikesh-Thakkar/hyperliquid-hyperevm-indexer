import { ethers } from 'ethers';
import type { Logger } from '../logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC20_WITHDRAW_TOPIC = ethers.id('Withdraw(address,uint256)');

/**
 * Maximum blocks per eth_getLogs request.
 * Some RPC providers cap this; 200 is a conservative limit.
 */
const MAX_LOG_RANGE = 200;

/**
 * Extra blocks added beyond the linear extrapolation for toBlock.
 * Accounts for block time variance over the search window — 120 blocks covers
 * roughly ±20% variance on a 10-minute window without over-scanning.
 */
const TO_BLOCK_BUFFER = 120;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface EvmTransferMatch {
  txHash: string;
  blockNumber: number;
  /** Unix epoch in milliseconds */
  timestamp: number;
  from: string;
  to: string;
  /** Raw token amount as bigint */
  amount: bigint;
}

type RawLog = { blockNumber: string; data: string; transactionHash: string; topics: string[] };

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Encapsulates all HyperEVM RPC interactions for block search, ERC-20 log
 * queries, and native transfer scanning.
 *
 * Dependencies are injected via the constructor, making the service testable
 * with a mock provider.
 */
export class HyperEvmService {
  constructor(
    private provider: ethers.JsonRpcProvider,
    private logger: Logger,
    private evmSearchWindowMs: number,
  ) {}

  /**
   * Verifies that the HyperEVM RPC is reachable by fetching the latest block number.
   * Called once at startup so the app fails fast with a clear error.
   */
  async checkConnectivity(): Promise<void> {
    const blockNumber = await this.provider.getBlockNumber();
    this.logger.info({ blockNumber }, '[HyperEVM] RPC connectivity verified');
  }

  // -------------------------------------------------------------------------
  // ERC-20 transfer resolution
  // -------------------------------------------------------------------------

  /**
   * Searches HyperEVM for the first unclaimed ERC-20 Transfer event matching a
   * known bridge transfer.
   *
   * Scans the block range chunk by chunk (MAX_LOG_RANGE blocks at a time) and
   * returns the first match whose txHash is not in `excludeTxHashes`, or null.
   */
  async findErc20Transfers(
    tokenContract: string,
    fromAddress: string,
    toAddress: string,
    amount: bigint,
    afterTimestampMs: number,
    windowMs = this.evmSearchWindowMs,
    excludeTxHashes: Set<string> = new Set(),
  ): Promise<EvmTransferMatch | null> {
    const { fromBlock, toBlock } = await this.getBlockRange(afterTimestampMs, windowMs);

    const fromTopic = ethers.zeroPadValue(fromAddress, 32);
    const toTopic   = ethers.zeroPadValue(toAddress,   32);

    for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
      const end = Math.min(start + MAX_LOG_RANGE - 1, toBlock);
      const transferLogs = await this.provider.send('eth_getLogs', [
        {
          address: ethers.getAddress(tokenContract),
          topics: [ERC20_TRANSFER_TOPIC, fromTopic, toTopic],
          fromBlock: ethers.toBeHex(start),
          toBlock: ethers.toBeHex(end),
        },
      ]) as RawLog[];

      const candidates = transferLogs.filter(
        (log) =>
          BigInt(log.data) === amount &&
          !excludeTxHashes.has(log.transactionHash),
      );

      // Assumption: bridge settles within 2 blocks of the Transfer event
      const withdrawLogs = await this.provider.send('eth_getLogs', [
        {
          address: ethers.getAddress(tokenContract),
          topics: [ERC20_WITHDRAW_TOPIC, toTopic],
          fromBlock: ethers.toBeHex(start),
          toBlock: ethers.toBeHex(start + 2),
        },
      ]) as RawLog[];

      const withdrawCandidates = withdrawLogs.filter(
        (log) =>
          BigInt(log.data) === amount &&
          !excludeTxHashes.has(log.transactionHash),
      );

      const allCandidates = [...candidates, ...withdrawCandidates];
      if (allCandidates.length === 0) continue;

      const firstLog = allCandidates[0];
      const blockNum = Number(BigInt(firstLog.blockNumber));
      const block = await this.provider.getBlock(blockNum);
      const timestamp = block ? block.timestamp * 1000 : 0;

      const topic1 = firstLog.topics?.[1];
      const from =
        topic1 && topic1.length >= 40
          ? ethers.getAddress('0x' + topic1.slice(-40))
          : '';

      return {
        txHash: firstLog.transactionHash,
        blockNumber: blockNum,
        timestamp,
        from,
        to: toAddress,
        amount: BigInt(firstLog.data),
      };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Native HYPE transfer resolution
  // -------------------------------------------------------------------------

  /**
   * Searches HyperEVM for the first unclaimed native HYPE transfer matching
   * the given criteria.
   *
   * Native transfers do not emit ERC-20 Transfer logs, so we must scan
   * individual blocks and inspect transaction values.
   */
  async findNativeTransfers(
    fromAddress: string,
    toAddress: string,
    amount: bigint,
    afterTimestampMs: number,
    windowMs = this.evmSearchWindowMs,
    excludeTxHashes: Set<string> = new Set(),
  ): Promise<EvmTransferMatch | null> {
    const { fromBlock, toBlock } = await this.getBlockRange(afterTimestampMs, windowMs);
    const normalizedFrom = fromAddress.toLowerCase();
    const normalizedTo = toAddress.toLowerCase();

    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      const block = await this.provider.getBlock(blockNum, true);
      if (!block || !block.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        if (tx.from?.toLowerCase() !== normalizedFrom) continue;
        if (tx.to?.toLowerCase() !== normalizedTo) continue;
        if (tx.value !== amount) continue;
        if (excludeTxHashes.has(tx.hash)) continue;

        return {
          txHash: tx.hash,
          blockNumber: blockNum,
          timestamp: block.timestamp * 1000,
          from: tx.from!,
          to: tx.to!,
          amount: tx.value ?? 0n,
        };
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Block range helpers (private)
  // -------------------------------------------------------------------------

  /**
   * Finds the first block whose timestamp >= targetSec using binary search.
   */
  private async findBlockByTimestamp(
    targetSec: number,
    lo: number,
    hi: number,
  ): Promise<number> {
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const block = await this.provider.getBlock(mid);

      if (!block) {
        hi = mid - 1;
        continue;
      }

      if (block.timestamp < targetSec) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    return lo;
  }

  /**
   * Computes a [fromBlock, toBlock] range for a given time window.
   *
   * Strategy:
   *   1. Binary-search for fromBlock (exact).
   *   2. Fetch fromBlock to anchor a local timestamp.
   *   3. Linearly extrapolate toBlock from that anchor.
   */
  private async getBlockRange(
    afterTimestampMs: number,
    windowMs: number,
  ): Promise<{ fromBlock: number; toBlock: number }> {
    const latestBlockNumber = await this.provider.getBlockNumber();
    const latest = await this.provider.getBlock(latestBlockNumber);
    if (!latest) throw new Error('[HyperEVM] Could not fetch latest block');

    const fromBlock = await this.findBlockByTimestamp(
      Math.floor(afterTimestampMs / 1000),
      0,
      latestBlockNumber,
    );

    const fromBlockData = await this.provider.getBlock(fromBlock);
    const anchorTimestamp = fromBlockData
      ? fromBlockData.timestamp
      : Math.floor(afterTimestampMs / 1000);

    const latestTimestamp = latest.timestamp;
    const elapsedSec = latestTimestamp - anchorTimestamp;
    const elapsedBlocks = latestBlockNumber - fromBlock;
    const avgBlockTimeSec = elapsedBlocks > 0 ? elapsedSec / elapsedBlocks : 1;

    const windowSec = windowMs / 1000;
    const toBlock = Math.min(
      latestBlockNumber,
      fromBlock + Math.ceil(windowSec / avgBlockTimeSec) + TO_BLOCK_BUFFER,
    );

    return { fromBlock, toBlock };
  }
}
