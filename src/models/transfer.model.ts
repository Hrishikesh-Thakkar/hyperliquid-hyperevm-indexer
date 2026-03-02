import { prop, getModelForClass, modelOptions, Severity, index } from '@typegoose/typegoose';

export type TransferStatus = 'pending' | 'matched' | 'failed';

/**
 * Represents a single sendAsset bridge transfer from Hyperliquid Spot to HyperEVM.
 *
 * Lifecycle:
 *   pending  → the HL transaction has been indexed but the EVM counterpart is not yet found
 *   matched  → the corresponding EVM transaction has been identified and recorded
 *   failed   → matcher gave up after MAX_RETRIES attempts
 */
@modelOptions({
  schemaOptions: {
    collection: 'transfers',
    timestamps: true, // adds createdAt / updatedAt automatically
  },
  options: { allowMixed: Severity.ALLOW },
})
@index({ sender: 1, hlTimestamp: -1 })
@index({ receiver: 1, hlTimestamp: -1 })
@index({ evmFrom: 1, receiver: 1, tokenSymbol: 1, amount: 1 })
/**
 * Partial unique index on evmTxHash: only indexes documents where evmTxHash
 * is an actual string value.  This allows unlimited pending records (null)
 * while still preventing two HL records from claiming the same EVM tx hash.
 *
 * A sparse index is NOT used here because MongoDB sparse indexes skip documents
 * where the field is absent, but they still index documents where the field is
 * explicitly set to null — which is exactly what Mongoose does for every new
 * pending record via the field's `default: null`.  That causes duplicate-key
 * errors as soon as a second pending record is inserted.
 */
@index(
  { evmTxHash: 1 },
  { unique: true, partialFilterExpression: { evmTxHash: { $type: 'string' } } },
)
export class TransferRecord {
  /** Hyperliquid transaction hash (unique identifier from HL) */
  @prop({ required: true, unique: true, index: true })
  hlTxHash!: string;

  /** HyperEVM transaction hash — null until matched. */
  @prop({ default: null })
  evmTxHash?: string | null;

  /** Sender wallet (the Hyperliquid account that initiated the transfer) */
  @prop({ required: true, index: true })
  sender!: string;

  /** Receiver wallet on HyperEVM (the `destination` field from the HL action) */
  @prop({ required: true, index: true })
  receiver!: string;

  /**
   * Raw Hyperliquid token identifier, e.g. "UETH:0xe1edd30daaf5caac3fe63569e24748da".
   * Format: "<name>:<hlInternalTokenId>"
   */
  @prop({ required: true })
  hlToken!: string;

  /**
   * The bridge system address that appears as `from` in the HyperEVM Transfer event.
   * Derived from the `destination` field of the HL sendAsset action — for ERC-20 tokens
   * this is `0x20` followed by the token's spot index in big-endian; for HYPE it is
   * `0x2222222222222222222222222222222222222222`.
   * Stored so the matcher can use it as an exact `from` topic filter on eth_getLogs,
   * avoiding false-positive matches from unrelated transfers to the same recipient.
   */
  @prop({ required: true })
  evmFrom!: string;

  /**
   * Corresponding ERC-20 contract address on HyperEVM.
   * Null for HYPE (the native gas token, which has no ERC-20 on HyperEVM).
   */
  @prop({ default: null })
  evmTokenAddress?: string | null;

  /** Human-readable token symbol, e.g. "UETH" or "HYPE" */
  @prop({ required: true })
  tokenSymbol!: string;

  /**
   * Transferred amount as a human-readable decimal string (e.g. "0.005995969").
   * Stored as a string to avoid floating-point precision loss.
   */
  @prop({ required: true })
  amount!: string;

  /**
   * Token decimals used when converting the amount to a bigint for EVM comparison.
   * Sourced from the `weiDecimals` field in Hyperliquid's spotMeta response.
   */
  @prop({ required: true })
  decimals!: number;

  /** When the HL transaction was broadcast (from HL API `time` field, ms epoch) */
  @prop({ required: true })
  hlTimestamp!: Date;

  /** Block timestamp of the matching HyperEVM transaction — null until matched */
  @prop({ default: null })
  evmTimestamp?: Date | null;

  /** HyperEVM block number of the matching transaction — null until matched */
  @prop({ default: null })
  evmBlockNumber?: number | null;

  /** Current matching state */
  @prop({ required: true, default: 'pending' })
  status!: TransferStatus;

  /** Number of times the matcher has tried (and failed) to find the EVM tx */
  @prop({ required: true, default: 0 })
  retryCount!: number;

  /** Timestamp of the last matcher attempt — used to enforce retry back-off */
  @prop({ default: null })
  lastRetryAt?: Date | null;
}

export const TransferModel = getModelForClass(TransferRecord);
