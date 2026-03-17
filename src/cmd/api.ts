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
import { initTokenCache } from '../services/token-cache';
import { startApiServer, stopApiServer } from '../api/server';
import { validateConfig } from '../config';
import { logger } from '../logger';

async function main(): Promise<void> {
  validateConfig();
  logger.info('[API] Starting API-only service');

  await connectDb();
  await initTokenCache();
  await startApiServer();

  logger.info('[API] Listening — indexer/matcher are NOT running in this process');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '[API] Shutting down');
    await stopApiServer();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, '[API] Fatal startup error');
  process.exit(1);
});
