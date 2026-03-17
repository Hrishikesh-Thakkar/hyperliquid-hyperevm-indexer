import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import mongoose from 'mongoose';
import { transferRoutes } from './routes/transfers';
import { config } from '../config';
import { processorState } from '../processor';
import { transferRepository } from '../repositories/transfer.repository';

export function buildServer(): FastifyInstance {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  void fastify.register(cors, { origin: '*' });
  fastify.register(transferRoutes);

  fastify.setErrorHandler((error, _req, reply) => {
    const status = error.statusCode ?? 500;
    void reply.status(status).send({ error: error.message ?? 'Internal server error' });
  });

  /**
   * Health check — returns 200 when all systems are operational, 503 when degraded.
   *
   * Checks:
   *   - MongoDB connection state
   *   - Whether the indexer and matcher have run recently (liveness, not just DB)
   *
   * Designed for Docker / load balancer probes.
   */
  fastify.get('/health', async (_req, reply) => {
    const dbState = mongoose.connection.readyState; // 1 = connected
    const dbOk = dbState === 1;

    const body = {
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      db: dbOk ? 'connected' : 'disconnected',
      indexer: {
        lastRunAt: processorState.indexerLastRunAt,
        lastError: processorState.indexerLastError,
      },
      matcher: {
        lastRunAt: processorState.matcherLastRunAt,
        lastError: processorState.matcherLastError,
      },
    };

    return reply.status(dbOk ? 200 : 503).send(body);
  });

  /**
   * Metrics endpoint — returns transfer counts by status.
   * Useful for dashboards and alerting on stuck pending queues.
   */
  fastify.get('/metrics', async (_req, reply) => {
    const counts = await transferRepository.countByStatus();
    return reply.send({
      transfers: counts,
      processor: {
        indexerLastRunAt: processorState.indexerLastRunAt,
        matcherLastRunAt: processorState.matcherLastRunAt,
      },
      timestamp: new Date().toISOString(),
    });
  });

  return fastify;
}

let server: FastifyInstance | null = null;

export async function startApiServer(): Promise<void> {
  server = buildServer();
  await server.listen({ port: config.apiPort, host: '0.0.0.0' });
  // Fastify's logger already prints the address; no extra log needed here
}

export async function stopApiServer(): Promise<void> {
  await server?.close();
}
