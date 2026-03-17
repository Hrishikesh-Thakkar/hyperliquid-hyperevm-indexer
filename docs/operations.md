# Operations Runbook

## Architecture overview

```
                         ┌─────────────┐
                         │   MongoDB   │
                         └──┬──────┬───┘
                            │      │
              ┌─────────────┘      └─────────────┐
              │                                   │
    ┌─────────▼─────────┐             ┌───────────▼─────────┐
    │   Worker (N)      │             │   API (N)           │
    │  ┌─────────────┐  │             │  GET /transfers/:w  │
    │  │   Indexer    │  │             │  GET /transfers/tx  │
    │  │   Matcher    │  │             │  GET /health        │
    │  └─────────────┘  │             │  GET /metrics        │
    └───────────────────┘             └─────────────────────┘
```

- **Worker** and **API** are separate processes; they share only MongoDB.
- Multiple worker replicas are safe — wallet locking (cursors) and atomic claiming (transfers) prevent duplicate work.
- API is stateless and can be scaled horizontally behind a load balancer.

---

## Health checks

### Endpoints

| Endpoint   | Purpose                                      |
|------------|----------------------------------------------|
| `/health`  | DB connectivity + indexer/matcher liveness    |
| `/metrics` | Prometheus-format metrics for scraping        |

### What to watch

| Metric / signal                       | Healthy                    | Alert threshold                     |
|---------------------------------------|----------------------------|-------------------------------------|
| `transfers_by_status{status="pending"}` | < 50                      | > 200 for 10 minutes              |
| `matcher_run_duration_seconds`        | < 30s                      | > 60s sustained                    |
| `indexer_last_run_timestamp`          | < 2× poll interval old     | No update for 5 minutes           |
| `matcher_last_run_timestamp`          | < 2× matcher interval old  | No update for 5 minutes           |
| `rpc_calls_total{status="error"}`     | < 5% of total              | > 20% error rate over 5 minutes   |
| `/health` status                      | `ok`                       | `degraded` for 30 seconds         |

---

## Common failure modes

### 1. HyperEVM RPC is down or rate-limiting

**Symptoms:**
- `matcher_transfers_total{result="retried"}` spikes
- `rpc_calls_total{status="error"}` rising
- Pending queue grows

**Recovery:**
- The matcher uses exponential backoff — it will self-heal once the RPC recovers.
- If prolonged: check `HYPEREVM_RPC_URL` config, switch to a backup RPC provider.
- Records are NOT lost — they remain `pending` and will be retried.

### 2. MongoDB connection lost

**Symptoms:**
- `/health` returns `503` with `db: "disconnected"`
- Logs show `[DB] Disconnected from MongoDB`

**Recovery:**
- Mongoose auto-reconnects. Watch for `[DB] Reconnected to MongoDB` in logs.
- If persistent: check MongoDB host, disk space, connection limits.
- The worker will resume from its cursor — no data loss.

### 3. Hyperliquid API returning errors

**Symptoms:**
- `[Indexer] Retriable error` in logs
- Cursor stops advancing for affected wallets

**Recovery:**
- The indexer stops the batch at the failing entry and retries on the next poll.
- Check `HL_API_URL` config and Hyperliquid status page.

### 4. Stuck pending transfers (match rate too low)

**Symptoms:**
- `transfers_by_status{status="pending"}` growing steadily
- `matcher_transfers_total{result="exhausted"}` increasing

**Investigation:**
```bash
# Find the oldest pending transfers
mongosh hl-indexer --eval "db.transfers.find({status:'pending'}).sort({hlTimestamp:1}).limit(5).pretty()"

# Check retry state
mongosh hl-indexer --eval "db.transfers.aggregate([{\\$match:{status:'pending'}},{\\$group:{_id:null,avgRetries:{\\$avg:'\\$retryCount'},maxRetries:{\\$max:'\\$retryCount'}}}])"
```

**Common causes:**
- `EVM_SEARCH_WINDOW_MS` too small — the EVM transaction settled outside the window
- Token decimals mismatch — amount comparison fails silently
- Block range estimation off due to variable block times

### 5. Worker crash loop

**Symptoms:**
- Container restarting repeatedly
- `[App] Fatal startup error` in logs

**Recovery:**
1. Check logs for the specific error (DB unreachable, RPC unreachable, config validation failure)
2. Wallet locks auto-expire after 2 minutes — no manual intervention needed
3. Soft-locks on transfer records expire after 60 seconds

---

## Operational procedures

### Backfill historical transfers

To re-index a wallet from the beginning:

```bash
# Reset the cursor for a specific wallet
mongosh hl-indexer --eval "db.cursors.updateOne({wallet:'0xYOUR_WALLET'}, {\\$set:{lastProcessedTime:0, lockedUntil:null}})"
```

The indexer will re-fetch all history on the next poll. Existing records are preserved (upsert on `hlTxHash`).

### Re-match failed transfers

To give failed transfers another chance:

```bash
# Reset all failed transfers back to pending
mongosh hl-indexer --eval "db.transfers.updateMany({status:'failed'}, {\\$set:{status:'pending', retryCount:0, nextRetryAt:null, lastRetryAt:null}})"
```

To reset a specific transfer:

```bash
mongosh hl-indexer --eval "db.transfers.updateOne({hlTxHash:'0xYOUR_HASH'}, {\\$set:{status:'pending', retryCount:0, nextRetryAt:null, lastRetryAt:null}})"
```

### Add a new wallet to track

1. Update the `WALLETS` environment variable (comma-separated list)
2. Restart the worker: `docker compose restart worker`

The new wallet starts indexing from the beginning (cursor defaults to 0).

### Clear stale locks (emergency)

If a crashed worker left locks that haven't expired:

```bash
# Clear all expired cursor locks
mongosh hl-indexer --eval "db.cursors.updateMany({lockedUntil:{\\$lt:new Date()}}, {\\$set:{lockedUntil:null}})"

# Clear all soft-locks on transfers
mongosh hl-indexer --eval "db.transfers.updateMany({status:'pending', nextRetryAt:{\\$lt:new Date()}}, {\\$set:{nextRetryAt:null}})"
```

---

## Scaling guide

### Horizontal scaling

| Component | Safe to scale? | Notes |
|-----------|---------------|-------|
| **API**   | Yes           | Stateless — add replicas freely |
| **Worker**| Yes           | Wallet-level locking + atomic record claiming prevent duplicates |
| **MongoDB**| Via replica set | Required for production — enables read scaling and HA |

### Tuning

| Parameter             | Effect of increasing                           | Risk                                    |
|-----------------------|------------------------------------------------|-----------------------------------------|
| `POLL_INTERVAL_MS`    | Less frequent HL API calls                     | Higher latency to detect new transfers  |
| `MATCHER_INTERVAL_MS` | Less frequent RPC calls                        | Slower matching                         |
| `EVM_SEARCH_WINDOW_MS`| Wider block scan range                         | More RPC calls per match attempt        |
| `MAX_RETRIES`         | More attempts before giving up                 | Longer time before marking as failed    |
| `RETRY_DELAY_MS`      | Base delay between retries (backoff multiplied)| Slower recovery from transient failures |
