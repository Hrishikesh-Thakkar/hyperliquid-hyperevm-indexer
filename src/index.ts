// Must be imported before any Typegoose model is accessed
import 'reflect-metadata';

import { connectDb, disconnectDb } from './db';
import { validateConfig } from './config';
import { createAppContext } from './context';
import { createIndexer } from './processor/indexer';
import { createMatcher } from './processor/matcher';
import { createProcessor } from './processor';
import { buildServer } from './api/server';

async function main(): Promise<void> {
  validateConfig();
  const ctx = createAppContext();
  ctx.logger.info('[App] Starting Hyperliquid → HyperEVM Indexer');

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

  const server = buildServer({
    config: ctx.config,
    processorState: processor.state,
    metricsRegistry: ctx.metricsRegistry,
  });
  await server.listen({ port: ctx.config.apiPort, host: '0.0.0.0' });

  ctx.logger.info('[App] All services running. Press Ctrl+C to stop.');

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info({ signal }, '[App] Shutting down gracefully');
    processor.stop();
    await server.close();
    await disconnectDb();
    ctx.logger.info('[App] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[App] Fatal startup error', err);
  process.exit(1);
});
