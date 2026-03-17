import mongoose from 'mongoose';
import { config } from './config';
import { TransferModel } from './models/transfer.model';
import { logger } from './logger';

export async function connectDb(): Promise<void> {
  mongoose.connection.on('disconnected', () => logger.warn('[DB] Disconnected from MongoDB'));
  mongoose.connection.on('error', (err) => logger.error({ err }, '[DB] Connection error'));
  mongoose.connection.on('reconnected', () => logger.info('[DB] Reconnected to MongoDB'));

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    appName: 'hl-indexer',
  });
  logger.info('[DB] Connected to MongoDB');

  // Align indexes with schema (evmTxHash is sparse unique so multiple pending nulls are allowed)
  await TransferModel.syncIndexes();
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  logger.info('[DB] Disconnected from MongoDB');
}
