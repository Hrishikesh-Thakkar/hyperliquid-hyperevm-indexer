import { prop, getModelForClass, modelOptions, Severity } from '@typegoose/typegoose';

/**
 * Tracks the indexer's progress per wallet so the service can restart
 * at any point without reprocessing already-ingested transactions.
 *
 * Also provides distributed locking via `lockedUntil` so that multiple
 * worker replicas can index wallets concurrently without duplicate work.
 */
@modelOptions({
  schemaOptions: {
    collection: 'cursors',
    timestamps: true,
  },
  options: { allowMixed: Severity.ALLOW },
})
export class WalletCursor {
  /** The wallet address this cursor belongs to (lowercased) */
  @prop({ required: true, unique: true, index: true })
  wallet!: string;

  /**
   * Millisecond epoch timestamp of the last Hyperliquid transaction that was
   * successfully ingested for this wallet.  The next poll uses startTime = this + 1.
   * Defaults to 0, which causes the indexer to fetch all available history on first run.
   */
  @prop({ required: true, default: 0 })
  lastProcessedTime!: number;

  /**
   * Distributed lock expiry. When a worker instance claims a wallet for
   * indexing, it sets this to now + lock duration. Other instances skip
   * wallets whose lock has not expired.
   *
   * Null means unlocked. Expired locks (lockedUntil < now) are also treated
   * as unlocked, providing automatic recovery if a worker crashes mid-run.
   */
  @prop({ default: null })
  lockedUntil?: Date | null;
}

export const CursorModel = getModelForClass(WalletCursor);
