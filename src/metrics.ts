import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

// Collect Node.js runtime metrics (event-loop lag, memory, GC, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ---------------------------------------------------------------------------
// Indexer metrics
// ---------------------------------------------------------------------------

export const indexerTransfersTotal = new Counter({
  name: 'indexer_transfers_total',
  help: 'Number of transfers processed by the indexer',
  labelNames: ['result'] as const, // ingested | skipped | retriable
  registers: [metricsRegistry],
});

export const indexerRunDuration = new Histogram({
  name: 'indexer_run_duration_seconds',
  help: 'Duration of a single indexer pass',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
});

export const indexerLastRunTimestamp = new Gauge({
  name: 'indexer_last_run_timestamp',
  help: 'Unix timestamp of the last successful indexer run',
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Matcher metrics
// ---------------------------------------------------------------------------

export const matcherTransfersTotal = new Counter({
  name: 'matcher_transfers_total',
  help: 'Number of transfers processed by the matcher',
  labelNames: ['result'] as const, // matched | retried | exhausted
  registers: [metricsRegistry],
});

export const matcherRunDuration = new Histogram({
  name: 'matcher_run_duration_seconds',
  help: 'Duration of a single matcher pass',
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const matcherLastRunTimestamp = new Gauge({
  name: 'matcher_last_run_timestamp',
  help: 'Unix timestamp of the last successful matcher run',
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Transfer queue depth (polled periodically)
// ---------------------------------------------------------------------------

export const transfersByStatus = new Gauge({
  name: 'transfers_by_status',
  help: 'Current number of transfer records by status',
  labelNames: ['status'] as const, // pending | matched | failed
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// External RPC metrics
// ---------------------------------------------------------------------------

export const rpcCallsTotal = new Counter({
  name: 'rpc_calls_total',
  help: 'Total RPC calls to HyperEVM',
  labelNames: ['method', 'status'] as const, // success | error
  registers: [metricsRegistry],
});

export const rpcLatency = new Histogram({
  name: 'rpc_latency_seconds',
  help: 'HyperEVM RPC call latency',
  labelNames: ['method'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});
