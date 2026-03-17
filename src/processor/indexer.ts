import { getBridgeTransfers, SendAssetEntry } from '../services/hyperliquid';
import { getTokenInfo, getEvmDecimals, getSystemAddress } from '../services/token-cache';
import { transferRepository } from '../repositories/transfer.repository';
import { CursorModel } from '../models/cursor.model';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Runs one indexer pass for every configured wallet.
 *
 * For each wallet:
 *   1. Load the cursor (last processed HL timestamp) from MongoDB.
 *   2. Fetch new spot→spot sendAsset entries from the HL SDK.
 *   3. Upsert each entry as a pending TransferRecord.
 *   4. Advance the cursor to the newest entry's timestamp.
 *
 * The upsert on `hlTxHash` makes this fully idempotent — safe to re-run
 * on restart without duplicating records.
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
  // Fetch-or-create the cursor for this wallet (atomic upsert)
  const cursor = await CursorModel.findOneAndUpdate(
    { wallet },
    { $setOnInsert: { wallet, lastProcessedTime: 0 } },
    { upsert: true, new: true },
  );

  const startTime = cursor.lastProcessedTime > 0 ? cursor.lastProcessedTime + 1 : undefined;
  const entries = await getBridgeTransfers(wallet, startTime);

  if (entries.length === 0) return;

  // Sort entries in ascending order of time
  entries.sort((a, b) => a.time - b.time);

  let newLastProcessedTime = cursor.lastProcessedTime;
  let successCount = 0;
  let failCount = 0;

  for (const entry of entries) {
    try {
      await ingestEntry(entry, wallet);
      newLastProcessedTime = Math.max(newLastProcessedTime, entry.time);
      successCount++;
    } catch (err) {
      // Log and continue — a single bad entry should not block the rest of the batch.
      // The cursor only advances for successful entries, so a failed entry whose
      // timestamp is lower than all successful ones will be retried next poll.
      // If a failed entry sits between two successful ones the cursor will advance
      // past it; such entries are expected to be rare (e.g. transient DB errors).
      logger.error({ wallet, hash: entry.hash, err }, '[Indexer] Failed to ingest entry');
      failCount++;
    }
  }

  if (newLastProcessedTime > cursor.lastProcessedTime) {
    await CursorModel.updateOne({ wallet }, { lastProcessedTime: newLastProcessedTime });
  }

  logger.info(
    { wallet, ingested: successCount, failed: failCount, cursor: newLastProcessedTime },
    '[Indexer] Wallet pass complete',
  );
}

async function ingestEntry(entry: SendAssetEntry, senderWallet: string): Promise<void> {
  const { delta } = entry;
  const tokenInfo = await getTokenInfo(delta.token);

  const decimals = tokenInfo ? getEvmDecimals(tokenInfo) : 18;
  const evmTokenAddress = tokenInfo?.evmContract?.address?.toLowerCase() ?? null;
  const tokenSymbol = tokenInfo?.name ?? delta.token.split(':')[0] ?? delta.token;

  // Validate that delta.destination is the expected system address for this token.
  // Plain P2P Hypercore transfers share the same sourceDex/destinationDex flags but
  // have a normal wallet address as the destination, not the bridge system address.
  const expectedSystemAddress = getSystemAddress(delta.token);
  if (!expectedSystemAddress) {
    logger.warn(
      { token: delta.token, hash: entry.hash },
      '[Indexer] Unknown token — cannot validate system address, skipping',
    );
    return;
  }

  if (delta.destination.toLowerCase() !== expectedSystemAddress.toLowerCase()) {
    logger.debug(
      { hash: entry.hash, destination: delta.destination, expected: expectedSystemAddress, token: tokenSymbol },
      '[Indexer] Skipping P2P transfer (destination is not system address)',
    );
    return;
  }

  // $setOnInsert ensures we never overwrite a record that was already matched/failed
  await transferRepository.upsertPending(entry.hash, {
    // delta.user is both the HL sender and the HyperEVM recipient (same address)
    sender: (delta.user ?? senderWallet).toLowerCase(),
    receiver: (delta.user ?? senderWallet).toLowerCase(),
    // delta.destination is the bridge system address — the `from` in the EVM Transfer event
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
}
