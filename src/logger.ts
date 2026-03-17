import pino from 'pino';

/**
 * Shared application logger (pino).
 *
 * Uses pino-pretty for local development and plain JSON in production.
 * The Fastify server creates its own child logger; this instance is used
 * by processors, services, and DB helpers that run outside the HTTP context.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
