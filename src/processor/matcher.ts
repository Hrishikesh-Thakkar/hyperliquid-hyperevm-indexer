import { ethers } from 'ethers';
import { DocumentType } from '@typegoose/typegoose';
import { TransferModel, TransferRecord } from '../models/transfer.model';
import { findErc20Transfers, findNativeTransfers } from '../services/hyperevm';
import { config } from '../config';

/** Symbol used to identify HYPE as the native gas token on HyperEVM */
const HYPE_SYMBOL = 'HYPE';

/** Symbol used to identify USDC as the USDC token on HyperEVM */
const USDC_SYMBOL = 'USDC';

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
 *   - lastRetryAt is null OR older than RETRY_DELAY_MS
 *
 * On success  → status set to 'matched', EVM fields populated.
 * On failure  → retryCount incremented; status set to 'failed' if exhausted.
 */
export async function runMatcher(): Promise<void> {
  const eligible = await TransferModel.find({
    status: 'pending',
    retryCount: { $lt: config.maxRetries },
    $or: [
      { lastRetryAt: null },
      { lastRetryAt: { $lt: new Date(Date.now() - config.retryDelayMs) } },
    ],
  })
    .sort({ retryCount: 1 , hlTimestamp: 1}) // those which haven't been tried then oldest first — prioritise longest-waiting records
    .limit(20); // cap per-run to avoid overwhelming the EVM RPC

  if (eligible.length === 0) return;

  console.log(`[Matcher] Processing ${eligible.length} pending transfer(s)`);

  for (const record of eligible) {
    try {
      await matchTransfer(record);
    } catch (err) {
      console.error(`[Matcher] Unexpected error on ${record.hlTxHash}:`, err);
      await markRetried(record._id, record.retryCount);
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
    console.error(`[Matcher] Cannot parse amount "${record.amount}" for ${record.hlTxHash}:`, err);
    await markRetried(record._id, record.retryCount, true /* exhaust retries */);
    return;
  }

  // Pre-load EVM tx hashes already claimed by sibling records sharing the same
  // transfer fingerprint (evmFrom + receiver + amount + token).  Passing this
  // exclusion set to the find functions lets them skip already-claimed candidates
  // without any DB write attempts that are known to fail.
  const usedHashes = await TransferModel.find({
    evmTxHash: { $ne: null },
    evmFrom: record.evmFrom,
    receiver: record.receiver,
    amount: record.amount,
    tokenSymbol: record.tokenSymbol,
    _id: { $ne: record._id },
  }).distinct('evmTxHash');

  const excludeSet = new Set(usedHashes as string[]);

  const afterTimestamp = record.hlTimestamp.getTime();

  const match =
    record.tokenSymbol === HYPE_SYMBOL || !record.evmTokenAddress
      ? await findNativeTransfers(record.evmFrom, record.receiver, amountBigInt, afterTimestamp, undefined, excludeSet)
      : await findErc20Transfers(record.evmTokenAddress, record.evmFrom, record.receiver, amountBigInt, afterTimestamp, undefined, excludeSet);

  if (match) {
    await TransferModel.updateOne(
      { _id: record._id },
      {
        $set: {
          status: 'matched',
          evmTxHash: match.txHash,
          evmTimestamp: new Date(match.timestamp),
          evmBlockNumber: match.blockNumber,
        },
      },
    );
    console.log(`[Matcher] ✓ Matched  ${record.hlTxHash}  →  ${match.txHash}`);
    return;
  }

  await markRetried(record._id, record.retryCount);
  console.log(
    `[Matcher] No EVM match found for ${record.hlTxHash} ` +
      `(attempt ${record.retryCount + 1}/${config.maxRetries})`,
  );
}

async function markRetried(
  id: DocumentType<TransferRecord>['_id'],
  currentRetryCount: number,
  forceExhaust = false,
): Promise<void> {
  const nextCount = currentRetryCount + 1;
  const exhausted = forceExhaust || nextCount >= config.maxRetries;

  await TransferModel.updateOne(
    { _id: id },
    {
      $set: {
        retryCount: nextCount,
        lastRetryAt: new Date(),
        ...(exhausted ? { status: 'failed' } : {}),
      },
    },
  );

  if (exhausted) {
    console.warn(`[Matcher] Giving up on record ${String(id)} after ${nextCount} attempt(s)`);
  }
}
