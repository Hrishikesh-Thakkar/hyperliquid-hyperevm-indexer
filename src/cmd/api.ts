/**
 * Standalone API entry point.
 *
 * Runs only the Fastify REST server — no indexer or matcher loops.
 * Use this when deploying the API as a separate horizontally-scalable service.
 *
 *   node dist/cmd/api.js
 */
import 'reflect-metadata';

import { connectDb, disconnectDb } from '../db';
import { validateConfig } from '../config';
import { createAppContext } from '../context';
import { buildServer } from '../api/server';

async function main(): Promise<void> {
  validateConfig();
  const ctx = createAppContext();
  ctx.logger.info('[API] Starting API-only service');

  await connectDb(ctx.config.mongoUri, ctx.logger);
  await ctx.tokenCache.init();

  const server = buildServer({
    config: ctx.config,
    processorState: null,
    metricsRegistry: ctx.metricsRegistry,
  });
  await server.listen({ port: ctx.config.apiPort, host: '0.0.0.0' });

  ctx.logger.info('[API] Listening — indexer/matcher are NOT running in this process');

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info({ signal }, '[API] Shutting down');
    await server.close();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[API] Fatal startup error', err);
  process.exit(1);
});
