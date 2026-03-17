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
import { initTokenCache } from '../services/token-cache';
import { checkEvmConnectivity } from '../services/hyperevm';
import { startProcessor, stopProcessor } from '../processor';
import { validateConfig } from '../config';
import { logger } from '../logger';

async function main(): Promise<void> {
  validateConfig();
  logger.info('[Worker] Starting worker-only service (indexer + matcher)');

  await connectDb();
  await checkEvmConnectivity();
  await initTokenCache();
  await startProcessor();

  logger.info('[Worker] Running — no HTTP server in this process');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '[Worker] Shutting down');
    stopProcessor();
    await disconnectDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, '[Worker] Fatal startup error');
  process.exit(1);
});
