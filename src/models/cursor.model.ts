import { prop, getModelForClass, modelOptions } from '@typegoose/typegoose';

/**
 * Tracks the indexer's progress per wallet so the service can restart
 * at any point without reprocessing already-ingested transactions.
 */
@modelOptions({
  schemaOptions: {
    collection: 'cursors',
    timestamps: true,
  },
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
}

export const CursorModel = getModelForClass(WalletCursor);
