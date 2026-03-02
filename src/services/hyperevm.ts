import { config } from '../config';
import {
  createPublicClient,
  http,
  getAddress,
  hexToBigInt,
  keccak256,
  numberToHex,
  padHex,
  stringToBytes,
} from 'viem';
import { hyperliquid } from 'viem/chains';

// ---------------------------------------------------------------------------
// Provider setup
// ---------------------------------------------------------------------------

/**
 * Shared viem public client for the HyperEVM network.
 * Connection is lazy — no requests are made until a method is called.
 */
export const hyperEvmProvider = createPublicClient({
  chain: hyperliquid,
  transport: http(config.hyperEvmRpcUrl, { timeout: 30_000 }),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ERC20_TRANSFER_TOPIC = keccak256(
  stringToBytes('Transfer(address,address,uint256)'),
);

const ERC20_WITHDRAW_TOPIC = keccak256(
  stringToBytes('Withdraw(address,uint256)'),
);

/**
 * Maximum blocks per eth_getLogs request.
 * Some RPC providers cap this; 2000 is a conservative limit.
 */
const MAX_LOG_RANGE = 200;

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

// ---------------------------------------------------------------------------
// Block range helpers
// ---------------------------------------------------------------------------

/**
 * Finds the number of the first block whose timestamp >= targetSec using binary search.
 *
 * `lo` and `hi` bound the search range — callers pass a linear estimate to seed
 * these tightly, cutting the number of iterations from ~log₂(chainLength) to ~log₂(seedRange).
 *
 * Accuracy: always within 1 block of the true answer regardless of chain history.
 * Cost: O(log(hi - lo)) RPC calls, typically 10–15 when seeded from a linear estimate.
 */
async function findBlockByTimestamp(
  targetSec: number,
  lo: number,
  hi: number,
): Promise<number> {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await hyperEvmProvider.getBlock({ blockNumber: BigInt(mid) });

    if (!block) {
      hi = mid - 1;
      continue;
    }

    const blockTimestamp = Number(block.timestamp);
    if (blockTimestamp < targetSec) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

/**
 * Extra blocks added beyond the linear extrapolation for toBlock.
 * Accounts for block time variance over the search window — 120 blocks covers
 * roughly ±20% variance on a 10-minute window without over-scanning.
 */
const TO_BLOCK_BUFFER = 120;

/**
 * Computes a [fromBlock, toBlock] range for a given time window.
 *
 * Strategy:
 *   1. Binary-search the full chain for fromBlock — exact, no block time assumptions.
 *   2. Fetch fromBlock to get its confirmed timestamp as a local anchor.
 *   3. Linearly extrapolate toBlock from that anchor using the window duration.
 *
 * Extrapolating toBlock from a nearby confirmed anchor (step 3) is safe because
 * the delta is small (windowMs). Any block time variance over a short window is
 * absorbed by TO_BLOCK_BUFFER. This saves one full binary search (~23 RPC calls).
 */
async function getBlockRange(
  afterTimestampMs: number,
  windowMs: number,
): Promise<{ fromBlock: number; toBlock: number }> {
  const latestBlockNumber = await hyperEvmProvider.getBlockNumber();
  const latest = await hyperEvmProvider.getBlock({
    blockNumber: latestBlockNumber,
  });
  if (!latest) throw new Error('[HyperEVM] Could not fetch latest block');

  const latestNum = Number(latestBlockNumber);
  const fromBlock = await findBlockByTimestamp(
    Math.floor(afterTimestampMs / 1000),
    0,
    latestNum,
  );

  const fromBlockData = await hyperEvmProvider.getBlock({
    blockNumber: BigInt(fromBlock),
  });
  const anchorTimestamp = fromBlockData
    ? Number(fromBlockData.timestamp)
    : Math.floor(afterTimestampMs / 1000);

  const latestTimestamp = Number(latest.timestamp);
  const elapsedSec = latestTimestamp - anchorTimestamp;
  const elapsedBlocks = latestNum - fromBlock;
  const avgBlockTimeSec = elapsedBlocks > 0 ? elapsedSec / elapsedBlocks : 1;

  const windowSec = windowMs / 1000;
  const toBlock = Math.min(
    latestNum,
    fromBlock + Math.ceil(windowSec / avgBlockTimeSec) + TO_BLOCK_BUFFER,
  );

  return { fromBlock, toBlock };
}

// ---------------------------------------------------------------------------
// ERC-20 transfer resolution
// ---------------------------------------------------------------------------

/**
 * Searches HyperEVM for the first unclaimed ERC-20 Transfer event matching a
 * known bridge transfer.
 *
 * Scans the block range chunk by chunk (MAX_LOG_RANGE blocks at a time) and
 * returns the first match whose txHash is not in `excludeTxHashes`, or null if
 * no unclaimed match is found.  Early exit means we stop scanning as soon as
 * we find a candidate — we do not scan the full window when a match appears early.
 *
 * Matching criteria:
 *   - emitted by `tokenContract`
 *   - `from` field equals `fromAddress` (exact topic filter)
 *   - `to` field equals `toAddress` (exact topic filter)
 *   - `value` equals `amount` (exact bigint match)
 *
 * The block range is split into MAX_LOG_RANGE-sized chunks to stay within
 * RPC provider limits.
 */
export async function findErc20Transfers(
  tokenContract: string,
  fromAddress: string,
  toAddress: string,
  amount: bigint,
  afterTimestampMs: number,
  windowMs = config.evmSearchWindowMs,
  excludeTxHashes: Set<string> = new Set(),
): Promise<EvmTransferMatch | null> {
  const { fromBlock, toBlock } = await getBlockRange(afterTimestampMs, windowMs);

  const fromTopic = padHex(fromAddress as `0x${string}`, { size: 32 });
  const toTopic   = padHex(toAddress   as `0x${string}`, { size: 32 });

  type RawLog = { blockNumber: string; data: string; transactionHash: string; topics: string[] };

  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
    const end = Math.min(start + MAX_LOG_RANGE - 1, toBlock);
    const transferLogs = await hyperEvmProvider.request({
      method: 'eth_getLogs',
      params: [
        {
          address: getAddress(tokenContract),
          topics: [ERC20_TRANSFER_TOPIC, fromTopic, toTopic],
          fromBlock: numberToHex(BigInt(start)),
          toBlock: numberToHex(BigInt(end)),
        },
      ],
    }) as RawLog[];

    const candidates = transferLogs.filter(
      (log) =>
        hexToBigInt(log.data as `0x${string}`) === amount &&
        !excludeTxHashes.has(log.transactionHash),
    );
    const withdrawLogs = await hyperEvmProvider.request({
      method: 'eth_getLogs',
      params: [
        {
          address: getAddress(tokenContract),
          topics: [ERC20_WITHDRAW_TOPIC, toTopic],
          fromBlock: numberToHex(BigInt(start)),
          toBlock: numberToHex(BigInt(start + 2)),
        },
      ],
    }) as RawLog[];

    const withdrawCandidates = withdrawLogs.filter(
      (log) =>
        hexToBigInt(log.data as `0x${string}`) === amount &&
        !excludeTxHashes.has(log.transactionHash),
    );
    const allCandidates = [...candidates, ...withdrawCandidates];
    if (allCandidates.length === 0) continue;

    // Fetch the block timestamp for the first candidate's block only
    const firstLog = allCandidates[0];
    const blockNum = Number(hexToBigInt(firstLog.blockNumber as `0x${string}`));
    const block = await hyperEvmProvider.getBlock({ blockNumber: BigInt(blockNum) });
    const timestamp = block ? Number(block.timestamp) * 1000 : 0;

    const topic1 = firstLog.topics?.[1];
    const from =
      topic1 && topic1.length >= 40
        ? getAddress(('0x' + topic1.slice(-40)) as `0x${string}`)
        : '';

    return {
      txHash: firstLog.transactionHash,
      blockNumber: blockNum,
      timestamp,
      from,
      to: toAddress,
      amount: hexToBigInt(firstLog.data as `0x${string}`),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Native HYPE transfer resolution
// ---------------------------------------------------------------------------

/**
 * Searches HyperEVM for the first unclaimed native HYPE transfer to `toAddress`
 * matching `amount`.
 *
 * Returns the first match whose txHash is not in `excludeTxHashes`, or null if
 * no unclaimed match is found in the block window.  Scanning stops immediately
 * on the first unclaimed candidate.
 *
 * Native transfers do not emit ERC-20 Transfer logs, so we must scan individual
 * blocks and inspect transaction values.  This is more expensive than log queries.
 *
 * Future improvement: if HyperEVM exposes a bridge system precompile that emits
 * events for native transfers, replace this with a getLogs call.
 */
export async function findNativeTransfers(
  fromAddress: string,
  toAddress: string,
  amount: bigint,
  afterTimestampMs: number,
  windowMs = config.evmSearchWindowMs,
  excludeTxHashes: Set<string> = new Set(),
): Promise<EvmTransferMatch | null> {
  const { fromBlock, toBlock } = await getBlockRange(afterTimestampMs, windowMs);
  const normalizedFrom = fromAddress.toLowerCase();
  const normalizedTo = toAddress.toLowerCase();

  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    const block = await hyperEvmProvider.getBlock({
      blockNumber: BigInt(blockNum),
      includeTransactions: true,
    });
    if (!block || !block.transactions) continue;

    for (const tx of block.transactions) {
      if (typeof tx === 'string') continue;
      if (tx.from?.toLowerCase() !== normalizedFrom) continue;
      if (tx.to?.toLowerCase() !== normalizedTo) continue;
      if (tx.value !== amount) continue;
      if (excludeTxHashes.has(tx.hash)) continue;

      return {
        txHash: tx.hash,
        blockNumber: blockNum,
        timestamp: Number(block.timestamp) * 1000,
        from: tx.from!,
        to: tx.to!,
        amount: tx.value ?? 0n,
      };
    }
  }

  return null;
}
