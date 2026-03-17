# Hyperliquid → HyperEVM Indexer

A production-ready service that tracks bridge transfers from **Hyperliquid Spot** to **HyperEVM**, correlates each one with its corresponding on-chain EVM transaction, and exposes the full dataset via a REST API.

---

## Architecture

```
┌─────────────────────┐     ┌───────────┐     ┌──────────────────────┐
│  Hyperliquid REST    │     │  MongoDB  │     │  HyperEVM JSON-RPC   │
└──────────┬──────────┘     └─────┬─────┘     └──────────┬───────────┘
           │                      │                       │
           │  userNonFunding      │                       │
           │  LedgerUpdates       │                       │
           ▼                      │                       │
   ┌───────────────┐              │                       │
   │   Indexer      │──upsert────▶│                       │
   │   (Worker)     │             │                       │
   └───────────────┘              │                       │
                                  │                       │
   ┌───────────────┐              │    eth_getLogs /       │
   │   Matcher      │◀──claim────│    getBlock            │
   │   (Worker)     │──update───▶│◀───────────────────────│
   └───────────────┘              │                       │
                                  │
   ┌───────────────┐              │
   │   REST API     │◀──query────│
   │   (API)        │            │
   └───────────────┘              │
         │                        │
     clients                      │
```

The system has three logical components that can run as a single process (default) or as independent services for production deployments:

| Component | Entry point | Scalable | Description |
|-----------|-------------|----------|-------------|
| **API** | `dist/cmd/api.js` | Horizontally (stateless) | Fastify REST server, health checks, Prometheus metrics |
| **Worker** | `dist/cmd/worker.js` | Yes (with locking) | Indexer + matcher loops |
| **All-in-one** | `dist/index.js` | Single instance | Convenience mode — runs all components |

---

## How it works

### Indexer

Runs every `POLL_INTERVAL_MS` (default 30 s). For each configured wallet it:

1. **Atomically claims** the wallet via `lockedUntil` on the cursor document — prevents duplicate work when running multiple worker replicas.
2. Loads the **cursor** (`lastProcessedTime`) from MongoDB.
3. Calls `userNonFundingLedgerUpdates` with `startTime = cursor + 1` so only new entries are fetched.
4. Filters entries to bridge transfers: `sendAsset` (spot→spot) and `spotTransfer` (USDC bridge).
5. Upserts each entry as a `pending` `TransferRecord` keyed on `hlTxHash` — fully idempotent, safe to re-run after a crash.
6. Advances the cursor to the newest successfully ingested timestamp.
7. **Releases the wallet lock** so other replicas can pick it up next interval.

**Error handling:** Errors are classified as retriable or non-retriable. Retriable errors (e.g. network timeout) stop the batch and preserve the cursor — the entry is retried on the next poll. Non-retriable errors (e.g. unknown token) advance the cursor past the bad entry so it doesn't block the pipeline.

### Matcher

Runs every `MATCHER_INTERVAL_MS` (default 30 s). For each eligible `pending` record it:

1. **Atomically claims** the record via `findOneAndUpdate` — sets a 60-second soft lock so other replicas skip it.
2. Converts the human-readable HL amount to a bigint using the token's EVM decimals.
3. Pre-loads already-claimed EVM tx hashes for the same transfer fingerprint to avoid double-claiming.
4. Binary-searches HyperEVM blocks to find the `fromBlock` matching the HL timestamp, then linearly extrapolates `toBlock` over the configured search window.
5. Queries `eth_getLogs` (ERC-20 tokens) or scans blocks directly (native HYPE) for a matching transfer.
6. On match: sets `status = 'matched'` and records the EVM tx hash, block number, and timestamp.
7. On no match: schedules a retry with **exponential backoff** (`retryDelayMs × 2^retryCount`, capped at 30 minutes). After `MAX_RETRIES` failed attempts the record is marked `failed`.

**Error classification:** RPC failures and DB timeouts are retriable (normal backoff). Bad data like unparseable amounts are non-retriable (immediately exhausted).

### Data model

**TransferRecord** (`transfers` collection)

| Field | Description |
|-------|-------------|
| `hlTxHash` | Hyperliquid transaction hash (unique key) |
| `evmTxHash` | HyperEVM transaction hash — null until matched |
| `sender` / `receiver` | Wallet address (lowercased) |
| `evmFrom` | Bridge system address that appears as `from` on the EVM Transfer event |
| `tokenSymbol` | e.g. `UETH`, `HYPE`, `USDC` |
| `evmTokenAddress` | ERC-20 contract on HyperEVM — null for native HYPE |
| `amount` | Human-readable decimal string (avoids float precision loss) |
| `decimals` | EVM token decimals used for bigint conversion |
| `hlTimestamp` | When the HL transaction was broadcast |
| `evmTimestamp` / `evmBlockNumber` | Set on match |
| `status` | `pending` → `matched` \| `failed` |
| `retryCount` / `nextRetryAt` | Matcher retry bookkeeping (exponential backoff) |

**WalletCursor** (`cursors` collection)

| Field | Description |
|-------|-------------|
| `wallet` | Wallet address (unique) |
| `lastProcessedTime` | Ms epoch of last ingested HL transaction |
| `lockedUntil` | Distributed lock expiry for multi-instance safety |

---

## REST API

### `GET /transfers/:wallet`

Returns all bridge transfers where the wallet is the sender or receiver.

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer (1–200) | `50` | Page size |
| `offset` | integer | `0` | Number of records to skip |
| `status` | `pending` \| `matched` \| `failed` | — | Filter by status |

**Response**

```json
{
  "total": 12,
  "offset": 0,
  "limit": 50,
  "transfers": [
    {
      "hlTxHash": "0xabc...",
      "evmTxHash": "0xdef...",
      "hypercoreTxUrl": "https://www.flowscan.xyz/tx/0xabc...",
      "evmTxUrl": "https://hyperevmscan.io/tx/0xdef...",
      "sender": "0x30d8...",
      "receiver": "0x30d8...",
      "tokenSymbol": "UETH",
      "amount": "0.005995969",
      "status": "matched",
      "hlTimestamp": "2024-06-01T12:00:00.000Z",
      "evmTimestamp": "2024-06-01T12:00:05.000Z",
      "evmBlockNumber": 1234567
    }
  ]
}
```

### `GET /transfers/tx/:hash`

Look up a single transfer by either its Hyperliquid tx hash or its HyperEVM tx hash. Returns `404` if not found.

### `GET /health`

Returns `200` when the service is operational, `503` when degraded. Includes processor liveness data.

```json
{
  "status": "ok",
  "timestamp": "2024-06-01T12:00:00.000Z",
  "db": "connected",
  "indexer": { "lastRunAt": "2024-06-01T11:59:45.000Z", "lastError": null },
  "matcher": { "lastRunAt": "2024-06-01T11:59:50.000Z", "lastError": null }
}
```

### `GET /metrics`

Prometheus text exposition format. Key metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `indexer_transfers_total` | counter | Transfers processed by the indexer (`ingested`, `skipped`, `retriable`) |
| `matcher_transfers_total` | counter | Transfers processed by the matcher (`matched`, `retried`, `exhausted`) |
| `indexer_run_duration_seconds` | histogram | Indexer pass duration |
| `matcher_run_duration_seconds` | histogram | Matcher pass duration |
| `transfers_by_status` | gauge | Current transfer counts by status |
| `rpc_calls_total` | counter | HyperEVM RPC calls by method and status |
| `rpc_latency_seconds` | histogram | HyperEVM RPC latency |

---

## Local setup

**Prerequisites:** Node.js 20+, a running MongoDB instance.

```bash
# 1. Install dependencies
npm install

# 2. Copy the example env file and fill in your values
cp .env.example .env

# 3. Start in development mode (tsx watch, no build step)
npm run dev
```

The API will be available at `http://localhost:3000`.

**Scripts**

```bash
npm run dev              # development mode (tsx, no build)
npm run build            # compile TypeScript → dist/
npm start                # run compiled output (all-in-one)
npm run typecheck        # type-check without emitting
npm test                 # run unit tests (vitest)
npm run test:integration # run integration tests (real MongoDB)
npm run test:watch       # vitest in watch mode
```

---

## Docker setup

### Quick start (all-in-one)

```bash
# Set your RPC URL (or add it to a .env file in the project root)
export HYPEREVM_RPC_URL=https://rpc.hyperliquid.xyz/evm

# Build and start
docker compose up --build
```

### Production (separate services)

The `docker-compose.yml` runs the API and worker as independent services:

```bash
# Start all services
docker compose up --build

# Scale the API layer
docker compose up --build --scale api=3

# Scale workers (safe — locking prevents duplicate work)
docker compose up --build --scale worker=2
```

The API service includes a Docker `HEALTHCHECK` on `/health`. The worker has no HTTP server — it only runs the indexer and matcher loops.

### Custom wallets

```bash
WALLETS=0xYourWallet1,0xYourWallet2 docker compose up --build
```

### Stopping

```bash
docker compose down          # stop containers, keep MongoDB volume
docker compose down -v       # stop containers and delete MongoDB data
```

---

## Configuration

All settings are read from environment variables. Copy `.env.example` to get started.

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | `mongodb://localhost:27017/hl-indexer` | MongoDB connection string |
| `HYPEREVM_RPC_URL` | `https://hyperliquid.drpc.org` | HyperEVM JSON-RPC endpoint |
| `HL_API_URL` | `https://api.hyperliquid.xyz/info` | Hyperliquid REST API base URL |
| `API_PORT` | `3000` | Port for the Fastify REST API |
| `WALLETS` | Four assessment wallets | Comma-separated list of wallet addresses to index |
| `POLL_INTERVAL_MS` | `30000` | How often the indexer polls Hyperliquid (ms) |
| `MATCHER_INTERVAL_MS` | `30000` | How often the matcher scans HyperEVM (ms) |
| `EVM_SEARCH_WINDOW_MS` | `600000` | Time window after an HL tx to search for its EVM counterpart (ms) |
| `MAX_RETRIES` | `5` | Matcher attempts before marking a record `failed` |
| `RETRY_DELAY_MS` | `120000` | Base delay between matcher retries — actual delay uses exponential backoff (ms) |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |

---

## Testing

### Unit tests

Mock all external dependencies (DB, RPC, HL API). Fast, isolated, no infra needed.

```bash
npm test              # 46 tests
```

### Integration tests

Run against a real MongoDB instance (via `mongodb-memory-server`). Verify queries, indexes, atomic operations, and the full API → DB → response path.

```bash
npm run test:integration   # 23 tests
```

---

## Project structure

```
src/
├── api/
│   ├── server.ts              # Fastify setup, health, metrics endpoints
│   └── routes/transfers.ts    # Transfer query endpoints
├── cmd/
│   ├── api.ts                 # Standalone API entry point
│   └── worker.ts              # Standalone worker entry point
├── models/
│   ├── transfer.model.ts      # TransferRecord schema (Typegoose)
│   └── cursor.model.ts        # WalletCursor schema
├── processor/
│   ├── index.ts               # Timer orchestrator, state tracking, metrics
│   ├── indexer.ts              # HL → MongoDB ingestion
│   └── matcher.ts             # MongoDB → HyperEVM correlation
├── repositories/
│   └── transfer.repository.ts # All TransferModel DB operations
├── services/
│   ├── hl-client.ts           # Shared Hyperliquid SDK client
│   ├── hyperliquid.ts         # Bridge transfer detection (sendAsset + USDC)
│   ├── hyperevm.ts            # EVM RPC: block search, log queries, native scans
│   └── token-cache.ts         # In-memory spotMeta cache (24h TTL)
├── config.ts                  # Typed config from env vars with validation
├── db.ts                      # MongoDB connection lifecycle
├── errors.ts                  # RetriableError / NonRetriableError framework
├── logger.ts                  # Shared pino logger
├── metrics.ts                 # Prometheus metric definitions
└── index.ts                   # All-in-one entry point
docs/
└── operations.md              # Runbook, failure modes, backfill, scaling
test/
└── integration/               # Integration tests (real MongoDB)
```

---

## Operations

See [`docs/operations.md`](docs/operations.md) for:

- Health check and alert threshold reference
- Common failure modes and recovery procedures
- Backfill and re-match procedures
- Scaling guide and tuning parameters
