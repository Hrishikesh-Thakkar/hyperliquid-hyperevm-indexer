import mongoose from 'mongoose';
import { TransferModel } from './models/transfer.model';
import type { Logger } from './logger';

export async function connectDb(uri: string, log: Logger): Promise<void> {
  mongoose.connection.on('disconnected', () => log.warn('[DB] Disconnected from MongoDB'));
  mongoose.connection.on('error', (err) => log.error({ err }, '[DB] Connection error'));
  mongoose.connection.on('reconnected', () => log.info('[DB] Reconnected to MongoDB'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    appName: 'hl-indexer',
  });
  log.info('[DB] Connected to MongoDB');

  // Align indexes with schema (evmTxHash is sparse unique so multiple pending nulls are allowed)
  await TransferModel.syncIndexes();
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
