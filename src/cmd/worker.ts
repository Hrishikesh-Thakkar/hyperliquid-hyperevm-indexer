/**
 * Standalone worker entry point.
 *
 * Runs the indexer and matcher loops — no HTTP server.
 * Use this when deploying workers behind a separate API service.
 *
 *   node dist/cmd/worker.js
 */
import 'reflect-metadata';

import { connectDb, disconnectDb } from '../db';
import { validateConfig } from '../config';
import { createAppContext } from '../context';
import { createIndexer } from '../processor/indexer';
import { createMatcher } from '../processor/matcher';
import { createProcessor } from '../processor';

async function main(): Promise<void> {
  validateConfig();
  const ctx = createAppContext();
  ctx.logger.info('[Worker] Starting worker-only service (indexer + matcher)');

  await connectDb(ctx.config.mongoUri, ctx.logger);
  await ctx.evmService.checkConnectivity();
  await ctx.tokenCache.init();

  const indexer = createIndexer({
    config: ctx.config,
    logger: ctx.logger,
    hlClient: ctx.hlClient,
    tokenCache: ctx.tokenCache,
    transferRepository: ctx.transferRepository,
    metrics: ctx.metrics,
  });

  const matcher = createMatcher({
    logger: ctx.logger,
    evmService: ctx.evmService,
    transferRepository: ctx.transferRepository,
    metrics: ctx.metrics,
  });

  const processor = createProcessor({
    config: ctx.config,
    logger: ctx.logger,
    indexer,
    matcher,
    transferRepository: ctx.transferRepository,
    metrics: ctx.metrics,
  });

  await processor.start();

  ctx.logger.info('[Worker] Running — no HTTP server in this process');

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info({ signal }, '[Worker] Shutting down');
    processor.stop();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Worker] Fatal startup error', err);
  process.exit(1);
});
