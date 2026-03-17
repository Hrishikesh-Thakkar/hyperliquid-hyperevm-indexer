import { runIndexer } from './indexer';
import { runMatcher } from './matcher';
import { config } from '../config';
import { logger } from '../logger';
import {
  indexerRunDuration,
  indexerLastRunTimestamp,
  matcherRunDuration,
  matcherLastRunTimestamp,
  transfersByStatus,
} from '../metrics';
import { transferRepository } from '../repositories/transfer.repository';

let indexerTimer: ReturnType<typeof setInterval> | null = null;
let matcherTimer: ReturnType<typeof setInterval> | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;
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
  // Refresh queue-depth gauges every 60s for the /metrics endpoint
  metricsTimer = setInterval(refreshQueueMetrics, 60_000);
  void refreshQueueMetrics();

  logger.info(
    { indexerIntervalSec: config.pollIntervalMs / 1000, matcherIntervalSec: config.matcherIntervalMs / 1000 },
    '[Processor] Running',
  );
}

/** Stops both loops (called during graceful shutdown). */
export function stopProcessor(): void {
  if (indexerTimer !== null) clearInterval(indexerTimer);
  if (matcherTimer !== null) clearInterval(matcherTimer);
  if (metricsTimer !== null) clearInterval(metricsTimer);
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

async function runIndexerSafe(): Promise<void> {
  const end = indexerRunDuration.startTimer();
  try {
    await runIndexer();
    processorState.indexerLastRunAt = new Date();
    processorState.indexerLastError = null;
    indexerLastRunTimestamp.set(Date.now() / 1000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    processorState.indexerLastError = msg;
    logger.error({ err }, '[Processor] Indexer run failed');
  } finally {
    end();
  }
}

async function runMatcherSafe(): Promise<void> {
  const end = matcherRunDuration.startTimer();
  try {
    await runMatcher();
    processorState.matcherLastRunAt = new Date();
    processorState.matcherLastError = null;
    matcherLastRunTimestamp.set(Date.now() / 1000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    processorState.matcherLastError = msg;
    logger.error({ err }, '[Processor] Matcher run failed');
  } finally {
    end();
  }
}

/** Refreshes the transfers_by_status gauge for Prometheus scrapes. */
async function refreshQueueMetrics(): Promise<void> {
  try {
    const counts = await transferRepository.countByStatus();
    for (const [status, count] of Object.entries(counts)) {
      transfersByStatus.set({ status }, count);
    }
  } catch {
    // Non-critical — silently skip if the DB is temporarily unavailable
  }
}
