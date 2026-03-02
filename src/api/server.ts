import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import mongoose from 'mongoose';
import { transferRoutes } from './routes/transfers';
import { config } from '../config';

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

  /** Health-check endpoint — live DB state check for Docker / load balancer probes */
  fastify.get('/health', async (_req, reply) => {
    const dbState = mongoose.connection.readyState; // 1 = connected
    if (dbState !== 1) {
      return reply.status(503).send({ status: 'degraded', db: 'disconnected' });
    }
    return reply.send({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
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
  console.log('[API] Server closed');
}
