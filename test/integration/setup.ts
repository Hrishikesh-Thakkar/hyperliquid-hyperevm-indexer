/**
 * Shared setup for integration tests.
 *
 * Starts an in-memory MongoDB (via mongodb-memory-server), connects Mongoose,
 * and tears everything down after all tests finish.
 */
import 'reflect-metadata';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { TransferModel } from '../../src/models/transfer.model';
import { CursorModel } from '../../src/models/cursor.model';

let mongoServer: MongoMemoryServer;

export async function setupMongo(): Promise<void> {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  await TransferModel.syncIndexes();
  await CursorModel.syncIndexes();
}

export async function teardownMongo(): Promise<void> {
  await mongoose.disconnect();
  await mongoServer.stop();
}

export async function clearCollections(): Promise<void> {
  await TransferModel.deleteMany({});
  await CursorModel.deleteMany({});
}
