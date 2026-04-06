import crypto from 'node:crypto';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import mongoose from 'mongoose';
import { transferRoutes } from './routes/transfers';
import type { ProcessorState } from '../processor';
import type { Registry } from 'prom-client';

export interface ServerDeps {
  config: { rateLimitMax: number; rateLimitWindowMs: number; apiPort: number };
  processorState: ProcessorState | null;
  metricsRegistry: Registry;
}

// ---------------------------------------------------------------------------
// Health endpoint schemas (for OpenAPI documentation)
// ---------------------------------------------------------------------------

const processorLivenessSchema = {
  type: ['object', 'null'],
  properties: {
    lastRunAt:  { type: ['string', 'null'], format: 'date-time' },
    lastError:  { type: ['string', 'null'] },
  },
} as const;

const healthResponseSchema = {
  type: 'object',
  properties: {
    status:    { type: 'string', enum: ['ok', 'degraded'] },
    timestamp: { type: 'string', format: 'date-time' },
    db:        { type: 'string', enum: ['connected', 'disconnected'] },
    indexer:   processorLivenessSchema,
    matcher:   processorLivenessSchema,
  },
} as const;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, processorState, metricsRegistry } = deps;

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    genReqId: (req) =>
      (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
  });

  // Echo the correlation ID back in every response
  fastify.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  void fastify.register(cors, { origin: '*' });

  // OpenAPI documentation
  void fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Hyperliquid HyperEVM Indexer API',
        description: 'Indexes bridge transfers between Hyperliquid Spot and HyperEVM, correlates with on-chain EVM transactions, and exposes the dataset via REST.',
        version: '1.1.0',
      },
      tags: [
        { name: 'Transfers', description: 'Bridge transfer queries' },
        { name: 'Infrastructure', description: 'Health checks and metrics' },
      ],
    },
  });

  void fastify.register(swaggerUi, {
    routePrefix: '/documentation',
  });

  // Rate-limit public endpoints — skip infrastructure routes
  if (config.rateLimitMax > 0) {
    void fastify.register(rateLimit, {
      max: config.rateLimitMax,
      timeWindow: config.rateLimitWindowMs,
      allowList: (_req, _key) => {
        const url = _req.url;
        return url === '/health' || url === '/metrics' || url.startsWith('/documentation');
      },
    });
  }

  fastify.register(transferRoutes);

  fastify.setErrorHandler((error, _req, reply) => {
    const status = error.statusCode ?? 500;
    void reply.status(status).send({ error: error.message ?? 'Internal server error' });
  });

  /**
   * Health check — returns 200 when all systems are operational, 503 when degraded.
   */
  fastify.get('/health', {
    schema: {
      tags: ['Infrastructure'],
      summary: 'Service health check',
      description: 'Returns 200 when operational, 503 when degraded. Includes DB connectivity and processor liveness.',
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema,
      },
    },
  }, async (_req, reply) => {
    const dbState = mongoose.connection.readyState;
    const dbOk = dbState === 1;

    const body = {
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      db: dbOk ? 'connected' : 'disconnected',
      indexer: processorState
        ? { lastRunAt: processorState.indexerLastRunAt, lastError: processorState.indexerLastError }
        : null,
      matcher: processorState
        ? { lastRunAt: processorState.matcherLastRunAt, lastError: processorState.matcherLastError }
        : null,
    };

    return reply.status(dbOk ? 200 : 503).send(body);
  });

  /**
   * Prometheus metrics endpoint.
   */
  fastify.get('/metrics', {
    schema: {
      tags: ['Infrastructure'],
      summary: 'Prometheus metrics',
      description: 'Returns metrics in Prometheus text exposition format.',
      response: {
        200: { type: 'string', description: 'Prometheus text format' },
      },
    },
  }, async (_req, reply) => {
    const metrics = await metricsRegistry.metrics();
    return reply.type(metricsRegistry.contentType).send(metrics);
  });

  return fastify;
}
