// Must be imported before any Typegoose model is accessed
import 'reflect-metadata';

import { connectDb, disconnectDb } from './db';
import { initTokenCache } from './services/token-cache';
import { checkEvmConnectivity } from './services/hyperevm';
import { startProcessor, stopProcessor } from './processor';
import { startApiServer, stopApiServer } from './api/server';
import { validateConfig } from './config';
import { logger } from './logger';

async function main(): Promise<void> {
  validateConfig();
  logger.info('[App] Starting Hyperliquid → HyperEVM Indexer');

  // Fail fast if external dependencies are unreachable
  await connectDb();
  await checkEvmConnectivity();
  await initTokenCache();

  await startProcessor();
  await startApiServer();

  logger.info('[App] All services running. Press Ctrl+C to stop.');

  // ---------------------------------------------------------------------------
  // Graceful shutdown — finish the current work items, close connections cleanly
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, '[App] Shutting down gracefully');
    stopProcessor();          // stops scheduling new runs; in-progress runs complete
    await stopApiServer();    // stops accepting new HTTP requests
    await disconnectDb();
    logger.info('[App] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, '[App] Fatal startup error');
  process.exit(1);
});
