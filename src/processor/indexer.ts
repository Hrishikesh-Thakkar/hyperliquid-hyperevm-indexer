import { getBridgeTransfers, SendAssetEntry } from '../services/hyperliquid';
import { getTokenInfo, getEvmDecimals, getSystemAddress } from '../services/token-cache';
import { transferRepository } from '../repositories/transfer.repository';
import { CursorModel } from '../models/cursor.model';
import { config } from '../config';
import { logger } from '../logger';
import { RetriableError, NonRetriableError, classifyUnknownError } from '../errors';
import { indexerTransfersTotal } from '../metrics';

/** How long a wallet lock is held (ms). Must exceed the longest possible indexer pass. */
const WALLET_LOCK_DURATION_MS = 120_000; // 2 minutes

/**
 * Runs one indexer pass for every configured wallet.
 *
 * Each wallet is atomically claimed via `lockedUntil` before processing.
 * If another worker instance already holds the lock, the wallet is skipped.
 * Locks auto-expire so a crashed worker does not permanently block a wallet.
 */
export async function runIndexer(): Promise<void> {
  for (const wallet of config.wallets) {
    try {
      await indexWallet(wallet);
    } catch (err) {
      logger.error({ wallet, err }, '[Indexer] Error indexing wallet');
    }
  }
}

async function indexWallet(wallet: string): Promise<void> {
  // Atomically claim the wallet: upsert if new, skip if another worker holds the lock
  const now = new Date();
  const lockExpiry = new Date(now.getTime() + WALLET_LOCK_DURATION_MS);

  const cursor = await CursorModel.findOneAndUpdate(
    {
      wallet,
      $or: [
        { lockedUntil: null },
        { lockedUntil: { $lt: now } }, // expired lock — safe to reclaim
      ],
    },
    {
      $setOnInsert: { wallet, lastProcessedTime: 0 },
      $set: { lockedUntil: lockExpiry },
    },
    { upsert: true, new: true },
  );

  if (!cursor) {
    // Another worker holds the lock for this wallet — skip
    logger.debug({ wallet }, '[Indexer] Wallet locked by another instance, skipping');
    return;
  }

  try {
    await processWallet(wallet, cursor.lastProcessedTime);
  } finally {
    // Release the lock so other instances can pick it up on the next interval
    await CursorModel.updateOne({ wallet }, { $set: { lockedUntil: null } });
  }
}

async function processWallet(wallet: string, lastProcessedTime: number): Promise<void> {
  const startTime = lastProcessedTime > 0 ? lastProcessedTime + 1 : undefined;
  const entries = await getBridgeTransfers(wallet, startTime);

  if (entries.length === 0) return;

  // Sort entries in ascending order of time so the cursor always moves forward
  entries.sort((a, b) => a.time - b.time);

  let newLastProcessedTime = lastProcessedTime;
  let successCount = 0;
  let skippedCount = 0;

  for (const entry of entries) {
    try {
      await ingestEntry(entry, wallet);
      newLastProcessedTime = Math.max(newLastProcessedTime, entry.time);
      successCount++;
      indexerTransfersTotal.inc({ result: 'ingested' });
    } catch (err) {
      const classified = classifyUnknownError(err);

      if (classified instanceof NonRetriableError) {
        // Permanent failure — advance the cursor past this entry.
        logger.warn(
          { wallet, hash: entry.hash, reason: classified.message },
          '[Indexer] Skipping non-retriable entry',
        );
        newLastProcessedTime = Math.max(newLastProcessedTime, entry.time);
        skippedCount++;
        indexerTransfersTotal.inc({ result: 'skipped' });
      } else {
        // Transient failure — stop the batch so the cursor doesn't advance past this entry.
        logger.error(
          { wallet, hash: entry.hash, err: classified.cause ?? classified },
          '[Indexer] Retriable error — stopping batch to preserve entry for next poll',
        );
        indexerTransfersTotal.inc({ result: 'retriable' });
        break;
      }
    }
  }

  if (newLastProcessedTime > lastProcessedTime) {
    await CursorModel.updateOne({ wallet }, { lastProcessedTime: newLastProcessedTime });
  }

  logger.info(
    { wallet, ingested: successCount, skipped: skippedCount, cursor: newLastProcessedTime },
    '[Indexer] Wallet pass complete',
  );
}

async function ingestEntry(entry: SendAssetEntry, senderWallet: string): Promise<void> {
  const { delta } = entry;

  let tokenInfo;
  try {
    tokenInfo = await getTokenInfo(delta.token);
  } catch (err) {
    throw new RetriableError(`Failed to fetch token info for "${delta.token}"`, err);
  }

  const decimals = tokenInfo ? getEvmDecimals(tokenInfo) : 18;
  const evmTokenAddress = tokenInfo?.evmContract?.address?.toLowerCase() ?? null;
  const tokenSymbol = tokenInfo?.name ?? delta.token.split(':')[0] ?? delta.token;

  const expectedSystemAddress = getSystemAddress(delta.token);
  if (!expectedSystemAddress) {
    throw new NonRetriableError(`Unknown token "${delta.token}" — not found in spotMeta`);
  }

  if (delta.destination.toLowerCase() !== expectedSystemAddress.toLowerCase()) {
    throw new NonRetriableError(
      `P2P transfer ${entry.hash}: destination ${delta.destination} is not the system address`,
    );
  }

  try {
    await transferRepository.upsertPending(entry.hash, {
      sender: (delta.user ?? senderWallet).toLowerCase(),
      receiver: (delta.user ?? senderWallet).toLowerCase(),
      evmFrom: delta.destination.toLowerCase(),
      hlToken: delta.token,
      evmTokenAddress,
      tokenSymbol,
      amount: delta.amount,
      decimals,
      hlTimestamp: new Date(entry.time),
      status: 'pending',
      retryCount: 0,
      lastRetryAt: null,
      nextRetryAt: null,
    });
  } catch (err) {
    throw classifyUnknownError(err);
  }
}
