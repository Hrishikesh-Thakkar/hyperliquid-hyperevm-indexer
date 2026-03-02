import { runIndexer } from './indexer';
import { runMatcher } from './matcher';
import { config } from '../config';

let indexerTimer: ReturnType<typeof setInterval> | null = null;
let matcherTimer: ReturnType<typeof setInterval> | null = null;
let indexerRunning = false;
let matcherRunning = false;

/**
 * Starts the two background loops:
 *   - Indexer: polls Hyperliquid for new sendAsset transactions
 *   - Matcher: resolves pending transfers against HyperEVM
 *
 * Both loops run immediately on startup, then repeat on their configured intervals.
 * A running-flag guard prevents concurrent runs if a pass takes longer than the interval.
 */
export async function startProcessor(): Promise<void> {
  console.log('[Processor] Starting indexer and matcher...');

  // Run once immediately so there's no wait on cold start
  await scheduleIndexer();
  await scheduleMatcher();

  indexerTimer = setInterval(scheduleIndexer, config.pollIntervalMs);
  matcherTimer = setInterval(scheduleMatcher, config.matcherIntervalMs);

  console.log(
    `[Processor] Running — indexer every ${config.pollIntervalMs / 1000}s, ` +
      `matcher every ${config.matcherIntervalMs / 1000}s`,
  );
}

/** Stops both loops (called during graceful shutdown). */
export function stopProcessor(): void {
  if (indexerTimer !== null) clearInterval(indexerTimer);
  if (matcherTimer !== null) clearInterval(matcherTimer);
  console.log('[Processor] Stopped');
}

async function scheduleIndexer(): Promise<void> {
  if (indexerRunning) {
    console.warn('[Processor] Indexer still running, skipping interval');
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
    console.warn('[Processor] Matcher still running, skipping interval');
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
  } catch (err) {
    console.error('[Processor] Indexer run failed:', err);
  }
}

async function runMatcherSafe(): Promise<void> {
  try {
    await runMatcher();
  } catch (err) {
    console.error('[Processor] Matcher run failed:', err);
  }
}
