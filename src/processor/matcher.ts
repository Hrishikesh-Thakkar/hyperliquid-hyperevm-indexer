import { ethers } from 'ethers';
import { DocumentType } from '@typegoose/typegoose';
import { TransferRecord } from '../models/transfer.model';
import { transferRepository } from '../repositories/transfer.repository';
import { findErc20Transfers, findNativeTransfers } from '../services/hyperevm';
import { logger } from '../logger';
import { RetriableError, NonRetriableError, classifyUnknownError } from '../errors';
import { matcherTransfersTotal } from '../metrics';

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
 * Runs one matcher pass: atomically claims eligible pending transfers and
 * attempts to locate their counterpart transaction on HyperEVM.
 *
 * Each record is claimed via findOneAndUpdate so that multiple worker replicas
 * never process the same record simultaneously.
 *
 * Error classification determines retry behaviour:
 *   NonRetriableError → force-exhaust retries immediately (bad data, will never match)
 *   RetriableError    → normal retry with exponential backoff (transient RPC/DB failure)
 */
export async function runMatcher(): Promise<void> {
  const eligible = await transferRepository.claimForMatching(20);

  if (eligible.length === 0) return;

  logger.info({ count: eligible.length }, '[Matcher] Processing pending transfers');

  for (const record of eligible) {
    try {
      await matchTransfer(record);
    } catch (err) {
      const classified = classifyUnknownError(err);
      const forceExhaust = classified instanceof NonRetriableError;

      if (forceExhaust) {
        logger.warn(
          { hlTxHash: record.hlTxHash, reason: classified.message },
          '[Matcher] Non-retriable failure — exhausting retries',
        );
        matcherTransfersTotal.inc({ result: 'exhausted' });
      } else {
        logger.error(
          { hlTxHash: record.hlTxHash, err: classified.cause ?? classified },
          '[Matcher] Retriable failure — will retry with backoff',
        );
        matcherTransfersTotal.inc({ result: 'retried' });
      }

      await transferRepository.markRetried(record._id, record.retryCount, forceExhaust);
    }
  }
}

async function matchTransfer(record: DocumentType<TransferRecord>): Promise<void> {
  let amountBigInt: bigint;
  try {
    const decimals = record.decimals;
    const amountStr =
      countDecimals(record.amount) > decimals
        ? truncateToDecimals(record.amount, decimals)
        : record.amount;
    amountBigInt = ethers.parseUnits(amountStr, decimals);
  } catch (err) {
    throw new NonRetriableError(`Cannot parse amount "${record.amount}" for ${record.hlTxHash}`, err);
  }

  let excludeSet: Set<string>;
  try {
    excludeSet = await transferRepository.findUsedEvmHashes(record);
  } catch (err) {
    throw new RetriableError(`DB error fetching exclusion set for ${record.hlTxHash}`, err);
  }

  const afterTimestamp = record.hlTimestamp.getTime();

  let match;
  try {
    match =
      record.tokenSymbol === HYPE_SYMBOL || !record.evmTokenAddress
        ? await findNativeTransfers(record.evmFrom, record.receiver, amountBigInt, afterTimestamp, undefined, excludeSet)
        : await findErc20Transfers(record.evmTokenAddress, record.evmFrom, record.receiver, amountBigInt, afterTimestamp, undefined, excludeSet);
  } catch (err) {
    throw new RetriableError(`HyperEVM RPC error for ${record.hlTxHash}`, err);
  }

  if (match) {
    await transferRepository.markMatched(
      record._id,
      match.txHash,
      new Date(match.timestamp),
      match.blockNumber,
    );
    logger.info({ hlTxHash: record.hlTxHash, evmTxHash: match.txHash }, '[Matcher] Transfer matched');
    matcherTransfersTotal.inc({ result: 'matched' });
    return;
  }

  await transferRepository.markRetried(record._id, record.retryCount);
  logger.info(
    { hlTxHash: record.hlTxHash, attempt: record.retryCount + 1 },
    '[Matcher] No EVM match found',
  );
  matcherTransfersTotal.inc({ result: 'retried' });
}
