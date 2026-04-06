import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export interface AppMetrics {
  indexerTransfersTotal: Counter;
  indexerRunDuration: Histogram;
  indexerLastRunTimestamp: Gauge;
  matcherTransfersTotal: Counter;
  matcherRunDuration: Histogram;
  matcherLastRunTimestamp: Gauge;
  transfersByStatus: Gauge;
  rpcCallsTotal: Counter;
  rpcLatency: Histogram;
}

export function createMetrics(registry: Registry): AppMetrics {
  collectDefaultMetrics({ register: registry });

  return {
    indexerTransfersTotal: new Counter({
      name: 'indexer_transfers_total',
      help: 'Number of transfers processed by the indexer',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    indexerRunDuration: new Histogram({
      name: 'indexer_run_duration_seconds',
      help: 'Duration of a single indexer pass',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    }),
    indexerLastRunTimestamp: new Gauge({
      name: 'indexer_last_run_timestamp',
      help: 'Unix timestamp of the last successful indexer run',
      registers: [registry],
    }),
    matcherTransfersTotal: new Counter({
      name: 'matcher_transfers_total',
      help: 'Number of transfers processed by the matcher',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    matcherRunDuration: new Histogram({
      name: 'matcher_run_duration_seconds',
      help: 'Duration of a single matcher pass',
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
      registers: [registry],
    }),
    matcherLastRunTimestamp: new Gauge({
      name: 'matcher_last_run_timestamp',
      help: 'Unix timestamp of the last successful matcher run',
      registers: [registry],
    }),
    transfersByStatus: new Gauge({
      name: 'transfers_by_status',
      help: 'Current number of transfer records by status',
      labelNames: ['status'] as const,
      registers: [registry],
    }),
    rpcCallsTotal: new Counter({
      name: 'rpc_calls_total',
      help: 'Total RPC calls to HyperEVM',
      labelNames: ['method', 'status'] as const,
      registers: [registry],
    }),
    rpcLatency: new Histogram({
      name: 'rpc_latency_seconds',
      help: 'HyperEVM RPC call latency',
      labelNames: ['method'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
  };
}

// Default instances for backward compatibility during migration
export const metricsRegistry = new Registry();
const defaultMetrics = createMetrics(metricsRegistry);

export const indexerTransfersTotal = defaultMetrics.indexerTransfersTotal;
export const indexerRunDuration = defaultMetrics.indexerRunDuration;
export const indexerLastRunTimestamp = defaultMetrics.indexerLastRunTimestamp;
export const matcherTransfersTotal = defaultMetrics.matcherTransfersTotal;
export const matcherRunDuration = defaultMetrics.matcherRunDuration;
export const matcherLastRunTimestamp = defaultMetrics.matcherLastRunTimestamp;
export const transfersByStatus = defaultMetrics.transfersByStatus;
export const rpcCallsTotal = defaultMetrics.rpcCallsTotal;
export const rpcLatency = defaultMetrics.rpcLatency;
