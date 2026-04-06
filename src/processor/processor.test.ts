import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createProcessor, ProcessorDeps } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(): ProcessorDeps {
  return {
    config: { pollIntervalMs: 30_000, matcherIntervalMs: 30_000 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    indexer: { run: vi.fn().mockResolvedValue(undefined) },
    matcher: { run: vi.fn().mockResolvedValue(undefined) },
    transferRepository: {
      countByStatus: vi.fn().mockResolvedValue({ pending: 0, matched: 0, failed: 0 }),
    } as any,
    metrics: {
      indexerRunDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
      indexerLastRunTimestamp: { set: vi.fn() },
      matcherRunDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
      matcherLastRunTimestamp: { set: vi.fn() },
      transfersByStatus: { set: vi.fn() },
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createProcessor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs indexer and matcher immediately on start', async () => {
    const deps = createMockDeps();
    const processor = createProcessor(deps);

    await processor.start();

    expect(deps.indexer.run).toHaveBeenCalledOnce();
    expect(deps.matcher.run).toHaveBeenCalledOnce();

    processor.stop();
  });

  it('schedules indexer and matcher on configured intervals', async () => {
    const deps = createMockDeps();
    const processor = createProcessor(deps);

    await processor.start();

    // After initial run
    expect(deps.indexer.run).toHaveBeenCalledTimes(1);

    // Advance timer by one interval
    await vi.advanceTimersByTimeAsync(30_000);

    expect(deps.indexer.run).toHaveBeenCalledTimes(2);
    expect(deps.matcher.run).toHaveBeenCalledTimes(2);

    processor.stop();
  });

  it('stop() clears all intervals', async () => {
    const deps = createMockDeps();
    const processor = createProcessor(deps);

    await processor.start();
    processor.stop();

    // Advance timers — nothing should run after stop
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.indexer.run).toHaveBeenCalledTimes(1); // only the initial run
    expect(deps.matcher.run).toHaveBeenCalledTimes(1);
  });

  it('updates processorState on successful runs', async () => {
    const deps = createMockDeps();
    const processor = createProcessor(deps);

    await processor.start();

    expect(processor.state.indexerLastRunAt).toBeInstanceOf(Date);
    expect(processor.state.indexerLastError).toBeNull();
    expect(processor.state.matcherLastRunAt).toBeInstanceOf(Date);
    expect(processor.state.matcherLastError).toBeNull();

    processor.stop();
  });

  it('records error in processorState when indexer fails', async () => {
    const deps = createMockDeps();
    deps.indexer.run = vi.fn().mockRejectedValue(new Error('indexer boom'));
    const processor = createProcessor(deps);

    await processor.start();

    expect(processor.state.indexerLastError).toBe('indexer boom');
    expect(processor.state.indexerLastRunAt).toBeNull(); // never succeeded

    processor.stop();
  });

  it('prevents concurrent indexer runs', async () => {
    const deps = createMockDeps();

    // Make the second indexer run hang while a third call fires
    let resolveSecondRun: () => void;
    let callCount = 0;
    deps.indexer.run = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        // Second call hangs until we resolve it
        return new Promise<void>((resolve) => { resolveSecondRun = resolve; });
      }
      return Promise.resolve();
    });

    const processor = createProcessor(deps);
    await processor.start(); // first run completes immediately

    // Advance to fire second run (hangs)
    const timerPromise = vi.advanceTimersByTimeAsync(30_000);

    // Advance again — third run should be skipped because second is still running
    await vi.advanceTimersByTimeAsync(30_000);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[Processor] Indexer still running, skipping interval',
    );

    // Clean up
    resolveSecondRun!();
    await timerPromise;
    processor.stop();
  });
});
