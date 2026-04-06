import pino, { Logger } from 'pino';

/**
 * Creates a pino logger instance.
 * Uses pino-pretty for local development and plain JSON in production.
 */
export function createLogger(level?: string): Logger {
  return pino({
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

/** Default shared application logger — used when DI context is not available. */
export const logger = createLogger();

export type { Logger };
