import { runIndexer } from './indexer';
import { runMatcher } from './matcher';
import { config } from '../config';
import { logger } from '../logger';

let indexerTimer: ReturnType<typeof setInterval> | null = null;
let matcherTimer: ReturnType<typeof setInterval> | null = null;
let indexerRunning = false;
let matcherRunning = false;

/**
 * Shared processor state — exposed to the health/metrics endpoints so they
 * can surface liveness information beyond just "DB is connected".
 */
export const processorState = {
  indexerLastRunAt: null as Date | null,
  indexerLastError: null as string | null,
  matcherLastRunAt: null as Date | null,
  matcherLastError: null as string | null,
};

/**
 * Starts the two background loops:
 *   - Indexer: polls Hyperliquid for new sendAsset transactions
 *   - Matcher: resolves pending transfers against HyperEVM
 *
 * Both loops run immediately on startup, then repeat on their configured intervals.
 * A running-flag guard prevents concurrent runs if a pass takes longer than the interval.
 */
export async function startProcessor(): Promise<void> {
  logger.info('[Processor] Starting indexer and matcher...');

  // Run once immediately so there's no wait on cold start
  await scheduleIndexer();
  await scheduleMatcher();

  indexerTimer = setInterval(scheduleIndexer, config.pollIntervalMs);
  matcherTimer = setInterval(scheduleMatcher, config.matcherIntervalMs);

  logger.info(
    { indexerIntervalSec: config.pollIntervalMs / 1000, matcherIntervalSec: config.matcherIntervalMs / 1000 },
    '[Processor] Running',
  );
}

/** Stops both loops (called during graceful shutdown). */
export function stopProcessor(): void {
  if (indexerTimer !== null) clearInterval(indexerTimer);
  if (matcherTimer !== null) clearInterval(matcherTimer);
  logger.info('[Processor] Stopped');
}

async function scheduleIndexer(): Promise<void> {
  if (indexerRunning) {
    logger.warn('[Processor] Indexer still running, skipping interval');
    return;
  }
  indexerRunning = true;
  try {
    await runIndexerSafe();
  } finally {
    indexerRunning = false;
  }
}

async function scheduleMatcher(): Promise<void> {
  if (matcherRunning) {
    logger.warn('[Processor] Matcher still running, skipping interval');
    return;
  }
  matcherRunning = true;
  try {
    await runMatcherSafe();
  } finally {
    matcherRunning = false;
  }
}

// Wrappers that swallow unhandled rejections so a single bad run doesn't kill the timer
async function runIndexerSafe(): Promise<void> {
  try {
    await runIndexer();
    processorState.indexerLastRunAt = new Date();
    processorState.indexerLastError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    processorState.indexerLastError = msg;
    logger.error({ err }, '[Processor] Indexer run failed');
  }
}

async function runMatcherSafe(): Promise<void> {
  try {
    await runMatcher();
    processorState.matcherLastRunAt = new Date();
    processorState.matcherLastError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    processorState.matcherLastError = msg;
    logger.error({ err }, '[Processor] Matcher run failed');
  }
}
