# Load test (`bun run test:load`)

**No results are recorded in this repository.** The experiment could not be run where this code was written
(no Docker/Bun), and inventing numbers would be worse than leaving them out. Run it and fill the table below.

## Methodology (what the script does)
1. Creates `--wallets` wallets (default 200, 100000.00 BRL each) spread over the targets.
2. `--concurrency` closed-loop workers (default 64) for `--duration` seconds (default 30) POST `/wagering/transactions`,
   2/3 `BET` and 1/3 `WIN`, round-robin over wallets and over the 3 API instances. Every request has a unique idempotency key.
3. Prints throughput, latency p50/p95/p99/max, a status-code histogram (error rate = anything other than 200/201),
   then calls `POST /wallets/:id/reconciliation` on **every** wallet (must all be consistent),
   and reads `outbox_lag_seconds` and the sum of `lock_conflicts_total` from each instance's `/metrics`.

Run: `docker compose up --build -d && bun run test:load -- --targets http://localhost:3001,http://localhost:3002,http://localhost:3003`

To stress the *hot wallet* path (the interesting one) run with `--wallets 1`: every request contends for one row lock;
expect throughput bounded by one short transaction at a time and visible `wallet_lock_wait_seconds`.

## Record here
| Field | Value |
|---|---|
| Machine (CPU / RAM / OS / Docker resources) | |
| Instances × pool size | 3 × `DB_POOL_MAX` |
| Wallets / concurrency / duration | |
| Throughput (req/s) | |
| p50 / p95 / p99 (ms) | |
| Error rate | |
| Lock conflicts | |
| Outbox lag (s) at end | |
| Reconciliation | n/n consistent |

Caveats to state with any result: load generator and everything else share one machine; LocalStack is not SQS; the
client is closed-loop (coordinated omission understates tail latency under saturation).
