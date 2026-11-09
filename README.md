# Distributed Wagering Processor

Wallet + wagering-transaction API (Bun · NestJS · MikroORM · PostgreSQL · SQS FIFO) designed to stay
**correct under concurrency, duplicates, retries, crashes and multiple instances**.

Design, trade-offs and guarantees: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

> ## ⚠️ Verification status — read this first
> This code was written in a sandbox **without Bun, Docker, PostgreSQL, LocalStack or network access**. What was and was not executed:
>
> | Verified here | Not executed here (please run) |
> |---|---|
> | **106 unit tests pass** (domain + use cases over in-memory doubles), run under Node with a `bun:test` shim | `bun install`, the Nest app, MikroORM, the migration SQL, the SQL repositories |
> | `tsc --strict` over the whole project with third-party libs stubbed as `any` — no errors in project code | `test/integration` and `test/concurrency` (written, never run), `docker compose`, the Dockerfile |
> | Found and fixed a real outbox-ordering bug through the unit tests | exact MikroORM v6 API details (`em.execute`, `Migrator`, `migrationsList`) |
>
> Expect small first-run fixes (SQL typos, library API details). The integration/concurrency suites are the tool for finding them.

## Run it

```bash
docker compose up --build        # postgres + localstack + one-shot migrate + 3 API instances (:3001 :3002 :3003)
curl localhost:3001/health/ready
```

Locally without Docker for the app: `docker compose up postgres localstack -d`, then
`cp .env.example .env && bun install && bun run migrate && bun run start`.

| Script | Does |
|---|---|
| `bun run migrate` / `migrate:down` | apply / revert migrations **and** create SQS queues (idempotent) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test:unit` | pure tests, no infrastructure |
| `bun run test:infra:up` then `test:integration`, `test:concurrency` | real PostgreSQL (:5433) + LocalStack (:4567); each test file gets its own database and queues |
| `bun run test:infra:down` | tear the test infra down |
| `bun run test:load -- --targets … --wallets 200 --duration 30` | load generator + final reconciliation + outbox lag — methodology in [LOAD_TEST.md](LOAD_TEST.md) (no results recorded) |

Each instance runs every role (HTTP, SQS consumer, outbox publisher, pending-reference worker); switch roles with `ENABLE_*` (see `.env.example`).

## API

```bash
# create a wallet
curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# a bet (Idempotency-Key is required)
curl -s -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' -d '{
    "providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
    "walletId":"<wallet id>","roundId":"round-1","gameId":"fortune-chimp",
    "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# same request again → 200 …"idempotentReplay":true (same transactionId, same balance, no second debit)
```

`REFUND`/`ROLLBACK` additionally send `"referenceExternalTransactionId"`.

| Method & path | Notes |
|---|---|
| `POST /wallets` | 201 · 409 `WALLET_ALREADY_EXISTS` |
| `GET /wallets/:id` | balance, version |
| `GET /wallets/:id/ledger?limit=&cursor=` | newest first, opaque stable cursor, `nextCursor` |
| `POST /wallets/:id/reconciliation` | ledger-rebuilt balance vs stored; never repairs |
| `POST /wagering/transactions` | 201/200 processed · 202 pending reference · 422 rejected · 409 conflict · 400 · 503 |
| `GET /wagering/transactions/:id` · `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `GET /health/live` · `/health/ready` · `/metrics` | |

### SQS input (`wager-transactions.fifo`)

```json
{ "messageId": "uuid", "type": "WagerTransactionRequested", "occurredAt": "2026-08-01T12:00:00Z",
  "data": { "idempotencyKey": "provider-a:tx-1", "providerId": "…", "externalTransactionId": "…", "playerId": "…",
            "walletId": "…", "roundId": "…", "gameId": "…", "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" } } }
```
Permanent failures land in `wager-transactions-dlq.fifo`; domain events go to `wager-events.fifo`.

## Layout

```
src/wallet · src/wagering · src/messaging · src/shared   domain (no framework / ORM / I/O)
src/application                                          use cases + ports
src/infrastructure                                       MikroORM + SQL repos, migrations, SQS, workers, logging, metrics
src/interfaces/http                                      controllers, error filter, auth extension point
test/unit · test/integration · test/concurrency          see ARCHITECTURE.md §12
```

## Headline decisions (details in ARCHITECTURE.md)

* **PostgreSQL decides, SQS only transports.** Correctness comes from the idempotency key, the persistent inbox and unique constraints — never from FIFO dedup/ordering.
* **Money is `bigint` minor units**, `NUMERIC(19,2)` in the database, decimal strings on every wire. No floats anywhere.
* **READ COMMITTED + per-wallet `SELECT … FOR UPDATE`**, plus a version guard, a gap-free `(wallet_id, wallet_version)` unique key and a *deferred trigger* that makes a wallet whose balance disagrees with its ledger impossible to commit.
* **Ledger is append-only at the database level** (triggers on UPDATE/DELETE/TRUNCATE).
* **Transactional outbox + `SKIP LOCKED` publishers** (at-least-once); **inbox + explicit ack-after-commit consumer**.
* Out-of-order REFUND/ROLLBACK are parked as `PENDING_REFERENCE` and resolved by wake-up or backoff, then rejected with a precise code if the reference never arrives.
* Known interpretation calls (one reversal per reference regardless of kind, equal-amount reversals only, extra `referenceExternalTransactionId` field) are listed in ARCHITECTURE.md §7.
