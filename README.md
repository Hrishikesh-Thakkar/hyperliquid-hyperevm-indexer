# Hyperliquid → HyperEVM Indexer

A service that tracks `sendAsset` bridge transfers from **Hyperliquid Spot** to **HyperEVM**, correlates each one with its corresponding on-chain EVM transaction, and exposes the full dataset via a REST API.

---

## How it works

When a user bridges a token from Hyperliquid Spot to HyperEVM they submit a `sendAsset` action on the Hyperliquid L1. Shortly after, the bridge settles on HyperEVM as either an ERC-20 `Transfer` event (for tokens like UETH, USDC) or a native HYPE transfer. The indexer stitches these two sides together.

### Pipeline

```
Hyperliquid REST API          MongoDB                   HyperEVM JSON-RPC
       │                         │                              │
       │  userNonFundingLedger   │                              │
       │──────────────────────► │  transfers (pending)         │
       │      Indexer            │                              │
       │                         │                              │
       │                         │  ◄── eth_getLogs / blocks ──│
       │                         │       Matcher                │
       │                         │                              │
       │                         │  transfers (matched)         │
       │                         │                              │
       │                         │  ◄──── REST API ─────────── client
```

### Indexer

Runs every `POLL_INTERVAL_MS` (default 30 s). For each configured wallet it:

1. Loads the **cursor** (`lastProcessedTime`) from MongoDB — the millisecond timestamp of the last ingested Hyperliquid transaction.
2. Calls `userNonFundingLedgerUpdates` with `startTime = cursor + 1` so only new entries are fetched.
3. Filters entries to `sourceDex === 'spot'` and `destinationDex === 'spot'` (spot-to-spot bridge sends) (Exception for USDC where we check spotTransfer as well).
4. Upserts each entry as a `pending` `TransferRecord` keyed on `hlTxHash` — fully idempotent, safe to re-run after a crash.
5. Advances the cursor to the newest successfully ingested timestamp.

### Matcher

Runs every `MATCHER_INTERVAL_MS` (default 30 s). For each eligible `pending` record it:

1. Converts the human-readable HL amount to a bigint using the token's EVM decimals (`weiDecimals + evm_extra_wei_decimals`).
2. Pre-loads already-claimed EVM tx hashes for the same transfer fingerprint (same sender/receiver/amount/token) to avoid double-claiming.
3. Binary-searches HyperEVM blocks to find the `fromBlock` matching the HL timestamp, then linearly extrapolates `toBlock` over the configured search window.
4. Queries `eth_getLogs` (ERC-20 tokens) or scans blocks directly (native HYPE) for a matching transfer (or withdrawal in the case of USDC).
5. On match: sets `status = 'matched'` and records the EVM tx hash, block number, and timestamp.
6. On no match: increments `retryCount` and sets `lastRetryAt`. After `MAX_RETRIES` failed attempts the record is marked `failed`.

### Data model

**TransferRecord** (`transfers` collection)

| Field | Description |
|-------|-------------|
| `hlTxHash` | Hyperliquid transaction hash (unique key) |
| `evmTxHash` | HyperEVM transaction hash — null until matched |
| `sender` / `receiver` | Wallet address (lowercased) |
| `evmFrom` | Bridge system address that appears as `from` on the EVM Transfer event |
| `tokenSymbol` | e.g. `UETH`, `HYPE` |
| `evmTokenAddress` | ERC-20 contract on HyperEVM — null for native HYPE |
| `amount` | Human-readable decimal string (avoids float precision loss) |
| `decimals` | EVM token decimals used for bigint conversion |
| `hlTimestamp` | When the HL transaction was broadcast |
| `evmTimestamp` / `evmBlockNumber` | Set on match |
| `status` | `pending` → `matched` \| `failed` |
| `retryCount` / `lastRetryAt` | Matcher retry bookkeeping |

**WalletCursor** (`cursors` collection)

Stores `lastProcessedTime` per wallet so the indexer resumes from the right point after a restart.

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

---

### `GET /transfers/tx/:hash`

Look up a single transfer by either its Hyperliquid tx hash or its HyperEVM tx hash. Returns `404` if not found.

---

### `GET /health`

Returns `200` when the service is up and MongoDB is connected. Returns `503` when the database is unreachable — useful for container health probes.

```json
{ "status": "ok", "db": "connected", "timestamp": "2024-06-01T12:00:00.000Z" }
```

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

**Other scripts**

```bash
npm run build       # compile TypeScript → dist/
npm start           # run compiled output
npm run typecheck   # type-check without emitting
npm test            # run unit tests (vitest)
npm run test:watch  # vitest in watch mode
```

---

## Docker setup

The only value you **must** provide is `HYPEREVM_RPC_URL`. Everything else has a working default.

```bash
# 1. Set your RPC URL (or add it to a .env file in the project root)
export HYPEREVM_RPC_URL=https://rpc.hyperliquid.xyz/evm

# 2. Build and start both the app and MongoDB
docker compose up --build
```

The app container waits for MongoDB to pass its health check before starting.

To index different wallets, pass a comma-separated list:

```bash
WALLETS=0xYourWallet1,0xYourWallet2 docker compose up --build
```

**Stopping**

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
| `HYPEREVM_RPC_URL` | `https://hyperliquid.drpc.org` | HyperEVM JSON-RPC endpoint — **required in Docker** |
| `HL_API_URL` | `https://api.hyperliquid.xyz/info` | Hyperliquid REST API base URL |
| `API_PORT` | `3000` | Port for the Fastify REST API |
| `WALLETS` | Four assessment wallets | Comma-separated list of wallet addresses to index |
| `POLL_INTERVAL_MS` | `30000` | How often the indexer polls Hyperliquid (ms) |
| `MATCHER_INTERVAL_MS` | `30000` | How often the matcher scans HyperEVM (ms) |
| `EVM_SEARCH_WINDOW_MS` | `600000` | Time window after an HL tx to search for its EVM counterpart (ms) |
| `MAX_RETRIES` | `5` | Matcher attempts before marking a record `failed` |
| `RETRY_DELAY_MS` | `120000` | Minimum wait between matcher retries per record (ms) |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |

---

## Future Improvements

1. **Webhooks** — Track wallet events via webhooks for near real-time updates instead of polling at fixed intervals.
2. **Persistent wallet storage** — Store tracked wallets in a database (or similar) instead of config/env.
3. **Wallet management REST API** — Add REST endpoints to add and remove tracked wallets (e.g. `POST`/`DELETE`).
4. **Block-by-timestamp via provider API** — Replace the current binary-search block detection with a provider API that returns a block number for a given timestamp, e.g. [Etherscan `getblocknobytime`](https://docs.etherscan.io/api-reference/endpoint/getblocknobytime) or [Alchemy](https://docs.alchemy.com/reference/alchemy-getblocknumber).
5. **Native transfer detection via provider** — Use a third-party provider (e.g. [Alchemy](https://docs.alchemy.com)) to detect native token transfers instead of scanning blocks and parsing transactions.
6. **Adding Concurrency** - Add parallelism to the existing system during indexing wallets and during transactionHash matching. Due to rate limit issues with public infrastructure this was intentionally left out.