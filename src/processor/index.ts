import { TransferRepository } from '../repositories/transfer.repository';
import type { Logger } from '../logger';
import type { AppMetrics } from '../metrics';

export interface ProcessorState {
  indexerLastRunAt: Date | null;
  indexerLastError: string | null;
  matcherLastRunAt: Date | null;
  matcherLastError: string | null;
}

export interface ProcessorDeps {
  config: { pollIntervalMs: number; matcherIntervalMs: number };
  logger: Logger;
  indexer: { run(): Promise<void> };
  matcher: { run(): Promise<void> };
  transferRepository: TransferRepository;
  metrics: Pick<AppMetrics, 'indexerRunDuration' | 'indexerLastRunTimestamp' | 'matcherRunDuration' | 'matcherLastRunTimestamp' | 'transfersByStatus'>;
}

/**
 * Creates a processor that orchestrates the indexer and matcher loops.
 *
 * Returns an object with start/stop lifecycle methods and a shared state object
 * that the API health endpoint can read.
 */
export function createProcessor(deps: ProcessorDeps) {
  const { config, logger, indexer, matcher, transferRepository, metrics } = deps;

  let indexerTimer: ReturnType<typeof setInterval> | null = null;
  let matcherTimer: ReturnType<typeof setInterval> | null = null;
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let indexerRunning = false;
  let matcherRunning = false;

  const state: ProcessorState = {
    indexerLastRunAt: null,
    indexerLastError: null,
    matcherLastRunAt: null,
    matcherLastError: null,
  };

  async function start(): Promise<void> {
    logger.info('[Processor] Starting indexer and matcher...');

    await scheduleIndexer();
    await scheduleMatcher();

    indexerTimer = setInterval(scheduleIndexer, config.pollIntervalMs);
    matcherTimer = setInterval(scheduleMatcher, config.matcherIntervalMs);
    metricsTimer = setInterval(refreshQueueMetrics, 60_000);
    void refreshQueueMetrics();

    logger.info(
      { indexerIntervalSec: config.pollIntervalMs / 1000, matcherIntervalSec: config.matcherIntervalMs / 1000 },
      '[Processor] Running',
    );
  }

  function stop(): void {
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
    const end = metrics.indexerRunDuration.startTimer();
    try {
      await indexer.run();
      state.indexerLastRunAt = new Date();
      state.indexerLastError = null;
      metrics.indexerLastRunTimestamp.set(Date.now() / 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.indexerLastError = msg;
      logger.error({ err }, '[Processor] Indexer run failed');
    } finally {
      end();
    }
  }

  async function runMatcherSafe(): Promise<void> {
    const end = metrics.matcherRunDuration.startTimer();
    try {
      await matcher.run();
      state.matcherLastRunAt = new Date();
      state.matcherLastError = null;
      metrics.matcherLastRunTimestamp.set(Date.now() / 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.matcherLastError = msg;
      logger.error({ err }, '[Processor] Matcher run failed');
    } finally {
      end();
    }
  }

  async function refreshQueueMetrics(): Promise<void> {
    try {
      const counts = await transferRepository.countByStatus();
      for (const [status, count] of Object.entries(counts)) {
        metrics.transfersByStatus.set({ status }, count);
      }
    } catch {
      // Non-critical — silently skip if the DB is temporarily unavailable
    }
  }

  return { start, stop, state };
}
