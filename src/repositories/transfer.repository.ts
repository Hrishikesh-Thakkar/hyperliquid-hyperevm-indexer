import { DocumentType } from '@typegoose/typegoose';
import { config } from '../config';
import { TransferModel, TransferRecord, TransferStatus } from '../models/transfer.model';

/**
 * Encapsulates all MongoDB interactions for TransferRecord documents.
 *
 * Keeping queries in one place means:
 *  - Business logic in processors stays free of query syntax.
 *  - Index / field changes only need updating here.
 *  - Easier to stub in tests.
 */
export class TransferRepository {
  /**
   * Returns pending records that are due for a matching attempt,
   * ordered by least-retried first then oldest first.
   */
  async findEligibleForMatching(limit = 20): Promise<DocumentType<TransferRecord>[]> {
    return TransferModel.find({
      status: 'pending',
      retryCount: { $lt: config.maxRetries },
      $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: new Date() } }],
    })
      .sort({ retryCount: 1, hlTimestamp: 1 })
      .limit(limit);
  }

  /**
   * Returns EVM tx hashes already claimed by sibling records that share the
   * same transfer fingerprint (evmFrom + receiver + amount + token).
   * Used to skip candidates that belong to a different HL transfer.
   */
  async findUsedEvmHashes(record: DocumentType<TransferRecord>): Promise<Set<string>> {
    const usedHashes = await TransferModel.find({
      evmTxHash: { $ne: null },
      evmFrom: record.evmFrom,
      receiver: record.receiver,
      amount: record.amount,
      tokenSymbol: record.tokenSymbol,
      _id: { $ne: record._id },
    }).distinct('evmTxHash');
    return new Set(usedHashes as string[]);
  }

  /** Marks a transfer as successfully matched on HyperEVM. */
  async markMatched(
    id: DocumentType<TransferRecord>['_id'],
    evmTxHash: string,
    evmTimestamp: Date,
    evmBlockNumber: number,
  ): Promise<void> {
    await TransferModel.updateOne(
      { _id: id },
      { $set: { status: 'matched', evmTxHash, evmTimestamp, evmBlockNumber } },
    );
  }

  /**
   * Increments retryCount and schedules the next retry using exponential backoff.
   * Marks the record as 'failed' once retries are exhausted.
   *
   * Backoff formula: retryDelayMs * 2^currentRetryCount, capped at 30 minutes.
   */
  async markRetried(
    id: DocumentType<TransferRecord>['_id'],
    currentRetryCount: number,
    forceExhaust = false,
  ): Promise<void> {
    const nextCount = currentRetryCount + 1;
    const exhausted = forceExhaust || nextCount >= config.maxRetries;
    const delayMs = Math.min(
      config.retryDelayMs * Math.pow(2, currentRetryCount),
      30 * 60 * 1000, // cap at 30 minutes
    );
    const nextRetryAt = exhausted ? null : new Date(Date.now() + delayMs);

    await TransferModel.updateOne(
      { _id: id },
      {
        $set: {
          retryCount: nextCount,
          lastRetryAt: new Date(),
          nextRetryAt,
          ...(exhausted ? { status: 'failed' } : {}),
        },
      },
    );
  }

  /**
   * Idempotent upsert for a new pending transfer.
   * $setOnInsert ensures already-matched/failed records are never overwritten.
   */
  async upsertPending(hlTxHash: string, fields: Partial<TransferRecord>): Promise<void> {
    await TransferModel.updateOne(
      { hlTxHash },
      { $setOnInsert: { hlTxHash, ...fields } },
      { upsert: true },
    );
  }

  /** Returns document counts grouped by status for the /metrics endpoint. */
  async countByStatus(): Promise<Record<TransferStatus, number>> {
    const results = await TransferModel.aggregate<{ _id: TransferStatus; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const base: Record<TransferStatus, number> = { pending: 0, matched: 0, failed: 0 };
    for (const row of results) {
      base[row._id] = row.count;
    }
    return base;
  }
}

export const transferRepository = new TransferRepository();
