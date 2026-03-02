// Must be imported before any Typegoose model is accessed
import 'reflect-metadata';

import { connectDb, disconnectDb } from './db';
import { initTokenCache } from './services/token-cache';
import { startProcessor, stopProcessor } from './processor';
import { startApiServer, stopApiServer } from './api/server';
import { validateConfig } from './config';

async function main(): Promise<void> {
  validateConfig();
  console.log('[App] Starting Hyperliquid → HyperEVM Indexer');

  await connectDb();
  await initTokenCache();
  await startProcessor();
  await startApiServer();

  console.log('[App] All services running. Press Ctrl+C to stop.');

  // ---------------------------------------------------------------------------
  // Graceful shutdown — finish the current work items, close connections cleanly
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[App] Received ${signal} — shutting down gracefully...`);
    stopProcessor();          // stops scheduling new runs; in-progress runs complete
    await stopApiServer();    // stops accepting new HTTP requests
    await disconnectDb();
    console.log('[App] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[App] Fatal startup error:', err);
  process.exit(1);
});
