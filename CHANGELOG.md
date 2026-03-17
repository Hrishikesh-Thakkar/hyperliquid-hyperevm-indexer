# Changelog

## [1.1.0] - 2026-03-17

### Architecture

- **Service separation** — API and worker (indexer + matcher) can now run as independent processes via `dist/cmd/api.js` and `dist/cmd/worker.js`, enabling independent scaling. The all-in-one `dist/index.js` entry point is preserved for convenience.
- **TransferRepository** — Extracted all `TransferModel` database operations into `src/repositories/transfer.repository.ts`, decoupling business logic from query syntax.
- **Multi-stage Dockerfile** — Replaced `COPY dist` with an in-image TypeScript build for fully reproducible container builds.
- **Docker Compose service separation** — `api` and `worker` run as separate services with shared env config via YAML anchors. API is horizontally scalable; workers are safe to replicate.

### Reliability

- **Retriable / non-retriable error framework** (`src/errors.ts`) — Errors are classified by recoverability. In the indexer, retriable errors (network timeout, DB down) stop the batch and preserve the cursor so the entry is retried next poll. Non-retriable errors (unknown token, bad data) advance the cursor past the entry. In the matcher, non-retriable errors immediately exhaust retries; retriable errors use normal backoff.
- **Exponential backoff** — Matcher retries now use `retryDelayMs * 2^retryCount` (capped at 30 min) instead of a fixed delay. New `nextRetryAt` field on `TransferRecord` drives the eligibility query.
- **Multi-instance safety** — Indexer atomically locks wallets via `lockedUntil` on the cursor document (auto-expires after 2 min if worker crashes). Matcher atomically claims records via `findOneAndUpdate` with a 60-second soft lock.
- **RPC startup check** — `checkEvmConnectivity()` verifies the HyperEVM RPC is reachable at boot. The app fails fast with a clear error instead of silently failing to match transfers.
- **Fixed USDC bridge detection** — `isBridgeSend` now returns `true` for `spotTransfer` entries with `token === 'USDC'`, fixing the failing test and enabling USDC bridge indexing.

### Observability

- **Structured logging** — Replaced all `console.log/warn/error` calls with pino structured logging. All log entries include contextual fields (wallet, hash, err, counts) for queryable output in log aggregators.
- **Prometheus metrics** (`src/metrics.ts`) — `/metrics` endpoint serves Prometheus text format. Counters: `indexer_transfers_total`, `matcher_transfers_total`, `rpc_calls_total`. Histograms: `indexer_run_duration_seconds`, `matcher_run_duration_seconds`, `rpc_latency_seconds`. Gauges: `transfers_by_status`, `indexer_last_run_timestamp`, `matcher_last_run_timestamp`. Node.js runtime metrics included via `collectDefaultMetrics`.
- **Richer `/health` endpoint** — Now returns indexer/matcher `lastRunAt` and `lastError` alongside DB state, giving operators visibility into whether the processing loops are actually alive.

### Testing

- **Integration test suite** — 23 tests running against a real MongoDB via `mongodb-memory-server`. Covers `TransferRepository` (upsert idempotency, atomic claiming, concurrent claim prevention, exclusion sets, exponential backoff, `countByStatus`) and the full API path (pagination, status filtering, response serialization, explorer URLs, 404 handling, `/health`, `/metrics`).
- **Updated unit tests** — Matcher tests now mock the repository instead of `TransferModel` directly. Added tests for RPC failure (retriable) and DB failure (retriable) paths. Total: 46 unit + 23 integration = **69 tests, 0 failing**.

### Documentation

- **Operations runbook** (`docs/operations.md`) — Failure modes and recovery, backfill and re-match procedures, alert threshold reference, scaling guide and tuning parameters.
- **README rewrite** — Architecture diagram, component table, updated data model docs, `/metrics` endpoint reference, Docker scaling examples, project structure tree, testing instructions.

### Dependencies

- Added `pino` (structured logging)
- Added `prom-client` (Prometheus metrics)
- Added `mongodb-memory-server`, `unplugin-swc`, `@swc/core` (dev — integration tests)
