import { ethers } from 'ethers';
import { DocumentType } from '@typegoose/typegoose';
import { TransferRecord } from '../models/transfer.model';
import { transferRepository } from '../repositories/transfer.repository';
import { findErc20Transfers, findNativeTransfers } from '../services/hyperevm';
import { logger } from '../logger';

/** Symbol used to identify HYPE as the native gas token on HyperEVM */
const HYPE_SYMBOL = 'HYPE';

/**
 * Returns the number of fractional digits in a decimal string.
 */
function countDecimals(value: string): number {
  const idx = value.indexOf('.');
  return idx === -1 ? 0 : value.length - idx - 1;
}

/**
 * Truncates a decimal string to at most `decimals` fractional digits (no rounding).
 */
function truncateToDecimals(value: string, decimals: number): string {
  const idx = value.indexOf('.');
  if (idx === -1 || decimals <= 0) return value;
  const whole = value.slice(0, idx);
  const frac = value.slice(idx + 1).slice(0, decimals);
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

/**
 * Runs one matcher pass: picks up pending transfers and attempts to locate
 * their counterpart transaction on HyperEVM.
 *
 * A record is eligible for matching when:
 *   - status === 'pending'
 *   - retryCount < MAX_RETRIES
 *   - nextRetryAt is null OR has passed (exponential backoff)
 *
 * On success  → status set to 'matched', EVM fields populated.
 * On failure  → retryCount incremented; status set to 'failed' if exhausted.
 */
export async function runMatcher(): Promise<void> {
  const eligible = await transferRepository.findEligibleForMatching(20);

  if (eligible.length === 0) return;

  logger.info({ count: eligible.length }, '[Matcher] Processing pending transfers');

  for (const record of eligible) {
    try {
      await matchTransfer(record);
    } catch (err) {
      logger.error({ hlTxHash: record.hlTxHash, err }, '[Matcher] Unexpected error');
      await transferRepository.markRetried(record._id, record.retryCount);
    }
  }
}

async function matchTransfer(record: DocumentType<TransferRecord>): Promise<void> {
  // Convert the human-readable HL amount to a bigint for exact EVM comparison.
  // If the amount has more decimal places than the token supports, truncate to avoid parseUnits errors.
  let amountBigInt: bigint;
  try {
    const decimals = record.decimals;
    const amountStr =
      countDecimals(record.amount) > decimals
        ? truncateToDecimals(record.amount, decimals)
        : record.amount;
    amountBigInt = ethers.parseUnits(amountStr, decimals);
  } catch (err) {
    logger.error({ hlTxHash: record.hlTxHash, amount: record.amount, err }, '[Matcher] Cannot parse amount');
    await transferRepository.markRetried(record._id, record.retryCount, true /* exhaust retries */);
    return;
  }

  const excludeSet = await transferRepository.findUsedEvmHashes(record);
  const afterTimestamp = record.hlTimestamp.getTime();

  const match =
    record.tokenSymbol === HYPE_SYMBOL || !record.evmTokenAddress
      ? await findNativeTransfers(record.evmFrom, record.receiver, amountBigInt, afterTimestamp, undefined, excludeSet)
      : await findErc20Transfers(record.evmTokenAddress, record.evmFrom, record.receiver, amountBigInt, afterTimestamp, undefined, excludeSet);

  if (match) {
    await transferRepository.markMatched(
      record._id,
      match.txHash,
      new Date(match.timestamp),
      match.blockNumber,
    );
    logger.info({ hlTxHash: record.hlTxHash, evmTxHash: match.txHash }, '[Matcher] Transfer matched');
    return;
  }

  await transferRepository.markRetried(record._id, record.retryCount);
  logger.info(
    { hlTxHash: record.hlTxHash, attempt: record.retryCount + 1 },
    '[Matcher] No EVM match found',
  );
}
