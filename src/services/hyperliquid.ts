import type { UserNonFundingLedgerUpdatesResponse } from '@nktkas/hyperliquid';
import { infoClient } from './hl-client';
import { getSystemAddress } from './token-cache';

// ---------------------------------------------------------------------------
// Derived types from the SDK response
// ---------------------------------------------------------------------------

/** A single ledger update entry as returned by the SDK */
type LedgerEntry = UserNonFundingLedgerUpdatesResponse[number];

/**
 * The `send` delta variant from userNonFundingLedgerUpdates.
 * Emitted when a user executes a sendAsset action (sourceDex/destinationDex identify bridge).
 */
type SendDelta = Extract<LedgerEntry['delta'], { type: 'send' }>;

/**
 * The `spotTransfer` delta variant (e.g. USDC bridge).
 * Has user, destination, token, amount, etc.; no sourceDex/destinationDex.
 */
type SpotTransferDelta = Extract<LedgerEntry['delta'], { type: 'spotTransfer' }>;

/** Union of delta types that represent a bridge transfer (HL → HyperEVM). */
type BridgeDelta = SendDelta | SpotTransferDelta;

/** A ledger entry narrowed to a bridge-capable delta (send or spotTransfer). */
export type SendAssetEntry = LedgerEntry & { delta: BridgeDelta };

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
 * Type-guard: narrows a ledger entry to a bridge transfer (HL → HyperEVM).
 *
 * Accepts:
 *   - delta.type === 'send' with sourceDex === 'spot' and destinationDex === 'spot'
 *   - delta.type === 'spotTransfer' with token === 'USDC' (USDC bridge only)
 */
export function isBridgeSend(entry: LedgerEntry): entry is SendAssetEntry {
  const d = entry.delta as {
    type?: string;
    token?: string;
    sourceDex?: string;
    destinationDex?: string;
  };
  if (d.type === 'spotTransfer') return d.token === 'USDC';
  return (
    d.type === 'send' &&
    d.sourceDex === 'spot' &&
    d.destinationDex === 'spot'
  );
}
