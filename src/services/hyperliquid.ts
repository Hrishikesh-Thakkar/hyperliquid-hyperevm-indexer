import type { UserNonFundingLedgerUpdatesResponse } from '@nktkas/hyperliquid';
import { infoClient } from './hl-client';

// ---------------------------------------------------------------------------
// Derived types from the SDK response
// ---------------------------------------------------------------------------

/** A single ledger update entry as returned by the SDK */
type LedgerEntry = UserNonFundingLedgerUpdatesResponse[number];

/**
 * The `send` delta variant from userNonFundingLedgerUpdates.
 * This is emitted when a user executes a sendAsset action.
 */
type SendDelta = Extract<LedgerEntry['delta'], { type: 'send' }>;

/** A ledger entry narrowed to the `send` delta type */
export type SendAssetEntry = LedgerEntry & { delta: SendDelta };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches all non-funding ledger updates for a wallet and returns only those
 * that represent a spot-to-spot bridge transfer (Hyperliquid → HyperEVM).
 *
 * Uses the SDK's `userNonFundingLedgerUpdates` method with an optional
 * `startTime` for cursor-based incremental indexing.
 *
 * @param wallet    Wallet address to query
 * @param startTime Only return entries at or after this ms epoch (for resumability)
 */
export async function getBridgeTransfers(
  wallet: string,
  startTime?: number,
): Promise<SendAssetEntry[]> {
  const entries = await infoClient.userNonFundingLedgerUpdates({
    user: wallet as `0x${string}`,
    startTime: startTime ?? undefined,
  });

  return entries.filter(isBridgeSend);
}

/**
 * Type-guard: narrows a ledger entry to a spot→spot sendAsset bridge transfer.
 *
 * Conditions:
 *   - delta.type === 'send'
 *   - delta.sourceDex === 'spot' (originating from Hyperliquid Spot)
 *   - delta.destinationDex === 'spot' (landing on HyperEVM)
 */
export function isBridgeSend(entry: LedgerEntry): entry is SendAssetEntry {
  const d = entry.delta as Partial<SendDelta>;
  return (
    d.type === 'send' &&
    d.sourceDex === 'spot' &&
    d.destinationDex === 'spot'
  );
}
