import { ethers } from 'ethers';
import { Registry } from 'prom-client';
import type { InfoClient } from '@nktkas/hyperliquid';
import { config } from './config';
import { createLogger, type Logger } from './logger';
import { createMetrics, type AppMetrics } from './metrics';
import { createInfoClient } from './services/hl-client';
import { HyperEvmService } from './services/hyperevm';
import { TokenCache } from './services/token-cache';
import { TransferRepository } from './repositories/transfer.repository';

export interface AppContext {
  config: typeof config;
  logger: Logger;
  hlClient: InfoClient;
  evmService: HyperEvmService;
  tokenCache: TokenCache;
  transferRepository: TransferRepository;
  metricsRegistry: Registry;
  metrics: AppMetrics;
}

/**
 * Wires all application dependencies and returns the shared context.
 *
 * This is the single place where services are instantiated and connected.
 * Entry points call this once, then pass slices of the context to subsystems.
 */
export function createAppContext(): AppContext {
  const cfg = config;
  const logger = createLogger();
  const registry = new Registry();
  const metrics = createMetrics(registry);
  const hlClient = createInfoClient(cfg.hlApiUrl);
  const evmProvider = new ethers.JsonRpcProvider(
    cfg.hyperEvmRpcUrl,
    999,
    { staticNetwork: true },
  );
  const evmService = new HyperEvmService(evmProvider, logger, cfg.evmSearchWindowMs);
  const tokenCache = new TokenCache(hlClient, logger);
  const transferRepository = new TransferRepository(cfg.maxRetries, cfg.retryDelayMs);

  return {
    config: cfg,
    logger,
    hlClient,
    evmService,
    tokenCache,
    transferRepository,
    metricsRegistry: registry,
    metrics,
  };
}
