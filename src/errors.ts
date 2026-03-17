/**
 * Error classification framework for the indexer pipeline.
 *
 * The distinction drives cursor advancement in the indexer:
 *
 *   RetriableError   — transient failure (network, DB down, rate limit).
 *                      The batch stops at this entry; cursor does NOT advance.
 *                      The entry will be retried on the next poll.
 *
 *   NonRetriableError — permanent failure (bad data, unknown token, validation).
 *                       The cursor advances past this entry — retrying it will
 *                       never produce a different result, so the batch continues.
 */

export class RetriableError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RetriableError';
    this.cause = cause;
  }
}

export class NonRetriableError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NonRetriableError';
    this.cause = cause;
  }
}

/**
 * Classifies an unknown error thrown by third-party code (e.g. network calls,
 * DB driver) into a RetriableError or NonRetriableError.
 *
 * Defaults to RetriableError — better to retry something that turns out to be
 * permanent than to silently skip data that might have succeeded.
 */
export function classifyUnknownError(err: unknown): RetriableError | NonRetriableError {
  if (err instanceof RetriableError || err instanceof NonRetriableError) return err;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Permanent failures that will never resolve on retry
    if (
      msg.includes('validation failed') ||
      msg.includes('cast to') ||           // mongoose cast error
      msg.includes('e11000')               // mongo duplicate key (already indexed)
    ) {
      return new NonRetriableError(err.message, err);
    }
  }

  // Transient: network timeouts, connection resets, DB pool exhaustion, etc.
  return new RetriableError(String(err instanceof Error ? err.message : err), err);
}
