import mongoose from 'mongoose';
import { config } from './config';
import { TransferModel } from './models/transfer.model';

export async function connectDb(): Promise<void> {
  mongoose.connection.on('disconnected', () => console.warn('[DB] Disconnected from MongoDB'));
  mongoose.connection.on('error', (err) => console.error('[DB] Connection error:', err));
  mongoose.connection.on('reconnected', () => console.info('[DB] Reconnected to MongoDB'));

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    appName: 'hl-indexer',
  });
  console.log('[DB] Connected to MongoDB');

  // Align indexes with schema (evmTxHash is sparse unique so multiple pending nulls are allowed)
  await TransferModel.syncIndexes();
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  console.log('[DB] Disconnected from MongoDB');
}
