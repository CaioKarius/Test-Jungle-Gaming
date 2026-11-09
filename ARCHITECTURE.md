# ARCHITECTURE

Distributed wagering processor: PostgreSQL is the single source of truth, SQS FIFO is only a transport,
and **every consistency guarantee is enforced twice** — once in the application, once in the schema.

## 1. Layers

```
interfaces/http  ─┐                      ┌─ infrastructure/persistence  (MikroORM, SQL repositories, UnitOfWork)
infrastructure/sqs (consumer) ─► application (use cases, ports) ◄─┤  infrastructure/sqs        (publisher, bootstrap)
infrastructure/workers ─┘                      │                  └─ infrastructure/observability
                                               ▼
                         domain: wallet/ · wagering/ · messaging/ · shared/   (no framework, no ORM, no I/O)
```

* **Domain** (`src/wallet`, `src/wagering`, `src/messaging`, `src/shared`): `Money`, `Wallet`, `WalletLedgerEntry`,
  `WagerTransaction`, `WagerProcessor` (the business rules as a pure service), `InboxMessage`, `OutboxMessage`,
  integration events. Zero imports from Nest, MikroORM or AWS.
* **Application** (`src/application`): use cases + **ports** (`UnitOfWork`, repositories, `EventPublisher`, `Clock`,
  `Metrics`, `Logger`). `SubmitWagerTransactionUseCase` is the *only* path that processes a wager: HTTP and the SQS
  consumer both call it.
* **Infrastructure**: adapters for those ports. `app.module.ts` is the only composition root.
* **Interfaces**: HTTP controllers, error filter, presenters, auth guard (extension point).

The domain is unit-tested without any infrastructure (106 tests, see §12).

## 2. Money

`Money` stores a `bigint` count of minor units. There is **no `number` in the money path**: parsing is regex +
`BigInt`, arithmetic is integer, formatting re-inserts the decimal point. Consequences:

* Input must be a JSON **string** matching `^(0|[1-9]\d*)(\.\d{1,2})?$`; `"25"` → `"25.00"`. Rejected: numbers, `null`, empty,
  `NaN`, `Infinity`, `1e3`, signs, spaces, leading zeros, >2 decimals, currency not `^[A-Z]{3}$`, values above 10¹³.
* `Money.from` rejects negatives (input contract); `Money.fromStored` accepts them solely so reconciliation can *report* a corrupt value.
* Mixed-currency arithmetic throws `CurrencyMismatchError`. The model is multi-currency (`wallet.currency`, one wallet per
  `(player, currency)`); a transaction in another currency is **REJECTED `CURRENCY_MISMATCH`**, never converted.
* **Persistence mapping**: `NUMERIC(19,2)` columns. Every read selects `col::text`, so `node-postgres` never converts to a JS float;
  every write passes the decimal string. Wire/event/ledger JSON carry `{ "amount": "75.00", "currency": "BRL" }`.

## 3. ORM choice and how it is used

MikroORM (preferred by the brief). It provides the connection pool, `em.transactional`, and the versioned **migrations**
(`up`/`down`, reversible). The financial hot path issues **explicit SQL through `em.execute` inside that transaction**:

* `SELECT … FOR UPDATE`, `INSERT … ON CONFLICT DO NOTHING RETURNING`, `FOR UPDATE SKIP LOCKED`, `NOT EXISTS`-guarded outbox claims
  and `::text` money reads are the actual mechanism of the design — stating them as SQL is clearer and more auditable than coaxing
  them out of a Unit of Work (whose flush ordering and identity map would add *hidden* writes to a code path whose value is
  being explicit).
* Domain classes are **not** ORM entities. Repositories map rows ⇄ aggregates by hand (`repositories.ts`), so the domain never
  imports the ORM and persistence quirks never leak into rules.
* Trade-off accepted: no entity metadata/auto-schema; the schema is authored in the migration. For this problem the schema *is* a
  first-class deliverable (constraints, triggers), so that is a feature.

## 4. Transaction & concurrency strategy

**Isolation: READ COMMITTED + a pessimistic per-wallet row lock** (`SELECT … FROM wallets WHERE id = ? FOR UPDATE`).

Why not the alternatives:

| Option | Why not |
|---|---|
| `SERIALIZABLE` | Aborts (40001) grow with contention on a hot wallet; every writer needs retry logic and the *useful* work is lost on each abort. |
| Optimistic only (version check) | Under contention most attempts fail and retry; throughput collapses exactly where it matters (one popular wallet). |
| Advisory locks | Work, but a row lock is tied to the data, released automatically on commit/rollback/crash, and visible in `pg_locks` with no extra bookkeeping. |
| Global lock | Serialises unrelated wallets; we need parallelism *across* wallets. |

The row lock serialises writers **of one wallet** only; different wallets proceed in parallel. Lock scope is "wallet row, for the
duration of one short transaction". `lock_timeout` (default 5 s) and `statement_timeout` (15 s) are `SET LOCAL`, so a stuck lock
becomes a retryable error, not a hung request.

On top of the lock, **defence in depth**:

1. `UPDATE wallets … WHERE version = :expected` → `ConcurrentWalletModificationError` (counted as `lock_conflicts_total{reason="version_mismatch"}`) if anything ever bypasses the lock.
2. `UNIQUE (wallet_id, wallet_version)` on the ledger: two writers can never both produce version *n*.
3. `CHECK (balance >= 0)` and a deferred constraint trigger that, **at COMMIT**, requires `wallets.balance == ledger.balance_after` for the wallet's current version (§6).

Deadlocks / lock timeouts / serialization failures re-run the *whole* transaction (max 3 attempts, jittered), then surface as
`TransientInfrastructureError` (HTTP 503 / SQS retry). Lock order is always **wallet → rows of that wallet**, in both the submit path and the
pending-reference worker, so they cannot deadlock each other.

### One transaction, five things

Inside one SQL transaction: inbox row → idempotency check → wallet lock → business rules (pure) → `wager_transactions` row →
wallet update → ledger entry → outbox events. All commit, or none. Rejections are *persisted* (auditable) but write no ledger entry
and do not move the balance.

## 5. Idempotency

Contract: `Idempotency-Key` header (HTTP) / `data.idempotencyKey` (SQS) identifies the **operation**. `externalTransactionId` is the provider's
transaction identity. Flow in `SubmitWagerTransactionUseCase`:

1. Lookup by key (no lock). Hit → replay (below).
2. Take the wallet lock, **re-check under the lock** (a twin may have committed while we waited), also check `(provider, externalTransactionId)` — same external id with a different key → `409 IDEMPOTENCY_CONFLICT`.
3. Decide, then `INSERT … ON CONFLICT DO NOTHING`. If another transaction won a cross-wallet race, nothing of ours is written and we answer as a replay/conflict. The unique constraints are the last line of defence; the application logic is an optimisation.

**Replay** returns the stored transaction with `idempotentReplay: true` and the balance **observed at decision time**
(`wager_transactions.observed_balance`), not the current one. A replay of a `PENDING_REFERENCE` returns `202 PENDING_REFERENCE`; of a `REJECTED`, `422` again.

**`payloadHash`** = SHA-256 hex of the canonical JSON (keys sorted recursively, no whitespace) of the business fields only:
`providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount normalised, currency}, referenceExternalTransactionId|null`.
Excluded: the idempotency key, correlation/message ids, any transport metadata. Same key + different hash → `409`, never silently "last wins".

## 6. Schema-level guarantees (migration `Migration20260801000000_initial`)

| Guarantee | Mechanism |
|---|---|
| One wallet per (player, currency) | `UNIQUE (player_id, currency)` |
| Idempotency | `UNIQUE (idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)` |
| One ledger entry per (wallet, transaction); versions never repeat | `UNIQUE (wallet_id, transaction_id)`; `UNIQUE (wallet_id, wallet_version)` |
| Inbox dedup | `PRIMARY KEY (consumer_name, message_id)` |
| A reference reverted at most once | partial `UNIQUE (reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Never negative | `CHECK (balance >= 0)`; ledger `balance_before/after >= 0` |
| Ledger arithmetic | `CHECK (credit: after = before + amount ∨ debit: after = before − amount)` |
| **Ledger is immutable** | `BEFORE UPDATE OR DELETE` row trigger + `BEFORE TRUNCATE` statement trigger raise |
| Terminal transactions are final; identity columns immutable | `BEFORE UPDATE OR DELETE` trigger on `wager_transactions` |
| Version moves exactly with the balance | `BEFORE UPDATE` trigger on `wallets` |
| **Balance ⇔ ledger agreement** | `DEFERRABLE INITIALLY DEFERRED` constraint trigger: at COMMIT, `wallets.balance = ledger.balance_after` where `wallet_version = wallets.version` (O(1) via the unique index) |
| Reversal/BET reference shape; status ⇄ failure_code ⇄ processed_at consistency | `CHECK`s |

Hardening not applied (needs deployment roles): run the app as a role without `UPDATE/DELETE/TRUNCATE` on `wallet_ledger_entries`, and without
`ALTER TABLE … DISABLE TRIGGER`. Table owners/superusers can always bypass triggers; the triggers protect against bugs and operators with app credentials, not against a DBA.

## 7. Business rules (README §7) and interpretation decisions

`WagerProcessor` is a pure service: `(wallet, transaction, reference?, alreadyReversed, retry-policy) → PROCESSED | REJECTED | PENDING_REFERENCE`.

| Kind | Effect | Reference |
|---|---|---|
| `BET` | debit | forbidden |
| `WIN` | credit | optional → if given must be a processed `BET` of the same provider/player/wallet/currency/round |
| `LOSS` | **no balance change, no ledger entry**, status PROCESSED | optional (same rule as WIN) |
| `REFUND` | credit | required, must be a processed `BET`, **same amount** |
| `ROLLBACK` | inverse of the reference (BET→credit, WIN→debit, REFUND→debit) | required, BET/WIN/REFUND, **same amount** |
| `OPENING` | internal credit at wallet creation | — (not submittable) |

Interpretation decisions (all documented because the brief left them open):

* **One reversal per reference, whichever kind.** The brief says a reference cannot be reverted twice "by the same kind of operation".
  Allowing REFUND *and then* ROLLBACK of the same BET would credit the stake twice, so the unique index covers both kinds → the second is `REJECTED ALREADY_REVERSED`.
* **Partial reversals are out of scope**: amount must equal the reference (`REFERENCE_AMOUNT_MISMATCH`).
* `ROLLBACK` that would drive the balance negative is `REJECTED REVERSAL_INSUFFICIENT_FUNDS`, a code distinct from `INSUFFICIENT_FUNDS` (operationally it is a support case, not "ask the player for money").
* `LOSS` is never reversible (`INVALID_REFERENCE_KIND`).
* `referenceExternalTransactionId` is an addition to the payload (the brief's example had no field for it but REFUND/ROLLBACK cannot work without one).
* Unknown wallet → `404` / DLQ and **not persisted** (the row would violate the `wallet_id` FK and there is no owner to audit against).

### Out-of-order references

A reference that does not exist yet puts the transaction in `PENDING_REFERENCE` (persisted, `202`). Resolution:

* **Immediate wake-up**: whenever any transaction becomes PROCESSED, dependents waiting on its `externalTransactionId` get `next_retry_at = now` (same SQL transaction).
* **Backoff worker** (every instance): `5 s · 2ⁿ`, capped at 5 min.
* **Limit: 10 attempts or 30 min** (whichever first), then `REJECTED REFERENCE_NOT_FOUND` (or `REFERENCE_NOT_PROCESSED` if the reference exists but never became processable) + `WagerTransactionRejected`. Justification: out-of-order delivery is seconds–minutes in practice; 30 min covers a provider-side incident, and beyond that holding an open obligation is worse than a clear, final answer the provider can reconcile. All values are env-configurable.
* Concurrent workers are safe: each retry takes the wallet lock, re-reads the row, and skips if it is no longer pending/due.

`FAILED` is used only by that worker when a *domain invariant* breaks on supposedly valid data: the transaction is parked as `FAILED(INVARIANT_VIOLATION)`, logged at error level and counted — terminal and auditable.

## 8. Messaging

### Inbox (inbound SQS)

`inbox_messages (consumer_name, message_id)` is inserted **in the same SQL transaction** as the effects. A visible inbox row therefore always means "effects committed".
A concurrent twin blocks on the unique index until the first transaction ends: committed → `DO NOTHING` (duplicate, ack); rolled back → it inserts and processes. We never rely on FIFO dedup/ordering for correctness.

### Consumer semantics

| Outcome | Action |
|---|---|
| Business result (PROCESSED / REJECTED / PENDING / replay / duplicate) | **delete after commit** |
| Permanent: malformed JSON, wrong type, validation error, unknown wallet, idempotency conflict, unexpected domain error | send to **DLQ** (with `failureReason`, `receiveCount`), then delete |
| Transient: DB down/lock timeout/unknown | `ChangeMessageVisibility` = `min(60, 2·2ⁿ⁻¹) s`; after `SQS_MAX_RECEIVE_COUNT` (5) attempts → DLQ |

The queue also has a native redrive policy at `maxReceiveCount + 2` as a safety net. If the process dies after commit and before delete, the message is redelivered and the inbox makes it a no-op (tested by simulating a lost ack).
Messages of one `MessageGroupId` are handled sequentially in a batch; groups in parallel.

### Outbox (outbound events)

Events are rows in `outbox_messages` written in the business transaction (`eventId` = outbox id). A publisher on every instance claims with
`FOR UPDATE … SKIP LOCKED`, publishes to the `wager-events.fifo` queue (`MessageGroupId` = wallet, `MessageDeduplicationId` = `eventId`), and marks rows in the same transaction.

* **At-least-once**: a publisher that dies mid-batch rolls back, locks vanish, another instance re-publishes. Consumers dedupe on `eventId` (and may order by `walletVersion`).
* Per-wallet order: a publisher stops a wallet's batch at the first failure, and `claimDue` excludes a message while an *earlier* one of the same wallet is backing off. **Limit**: two publishers can still interleave one wallet's *healthy* messages across batches; the broker's FIFO group and `walletVersion` restore order for consumers.
* Failure → `attempts+1`, exponential backoff (1 s … 60 s).
* Events: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` (only when the balance really changes). Envelope: `eventId, eventType, aggregateId, correlationId, causationId, occurredAt, version, data`.

## 9. Reconciliation

`POST /wallets/:id/reconciliation` rebuilds the balance from the ledger in **one SQL statement** (one MVCC snapshot — the stored balance and the sum cannot be read at different instants).
It never repairs: a divergence is returned (`consistent:false`, `difference`), logged at error level and counted in `reconciliation_divergences_total`.

## 10. API contract

| Status | Meaning (identical across endpoints) |
|---|---|
| 201 | transaction processed (first time) · wallet created |
| 200 | replay of a processed transaction · reads |
| 202 | accepted, `PENDING_REFERENCE` |
| 400 | invalid payload (`details[]` per field) |
| 404 | wallet / transaction not found |
| 409 | `IDEMPOTENCY_CONFLICT` · `WALLET_ALREADY_EXISTS` |
| 422 | **business rejection**, final; body has `failureCode` + `providerAction` |
| 503 | transient infrastructure failure, `Retry-After`, `retryable:true` — resend with the **same** key |
| 500 | unexpected |

Errors: `{ "error": { "code", "message", "retryable", "details?" } }`.

### Failure codes (`providerAction` tells the provider what to do)

| Code | Status | `providerAction` | Meaning |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | `RESEND_AS_NEW_TRANSACTION` | BET larger than balance. Same key will replay the rejection forever; use a new `externalTransactionId` once funds exist |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | `CONTACT_SUPPORT` | ROLLBACK would debit below zero |
| `CURRENCY_MISMATCH` / `PLAYER_MISMATCH` | REJECTED | `FIX_PAYLOAD` | |
| `REFERENCE_NOT_FOUND` | REJECTED | `FIX_PAYLOAD` | reference never arrived within the retry budget |
| `REFERENCE_NOT_PROCESSED` | REJECTED | `GIVE_UP` | the referenced operation was itself rejected |
| `REFERENCE_CONTEXT_MISMATCH` / `INVALID_REFERENCE_KIND` / `REFERENCE_AMOUNT_MISMATCH` | REJECTED | `FIX_PAYLOAD` | |
| `ALREADY_REVERSED` | REJECTED | `GIVE_UP` | already refunded/rolled back |
| `INFRASTRUCTURE_FAILURE` / `INVARIANT_VIOLATION` | FAILED | `CONTACT_SUPPORT` | terminal, audited |

## 11. Observability, shutdown, auth

* **Logs**: JSON lines, with `correlationId` (from `X-Correlation-Id` or the SQS `messageId`), `messageId`, `transactionId`, `walletId`, `providerId` via `AsyncLocalStorage`. Keys like `money`, `amount`, `balance`, `payload`, `body` are stripped from every line, so financial payloads are never logged.
* **Metrics** (`GET /metrics`, Prometheus; scrape every instance): `wager_transactions_total{status,kind}`, `duplicates_detected_total{source}`, `retries_total{component}`, `dlq_messages_total{reason}`, `lock_conflicts_total{reason}`, `wallet_lock_wait_seconds`, `transaction_processing_duration_seconds{source}`, `outbox_lag_seconds`, `outbox_pending_messages`, `outbox_published_total`, `reconciliation_divergences_total`, `sqs_messages_total{outcome}` + process defaults.
* **Health**: `/health/live` (process), `/health/ready` (PostgreSQL `SELECT 1` + SQS queue attributes, 2 s timeouts, 503 when down).
* **Graceful shutdown** (SIGTERM): consumer stops polling and aborts the long poll; the message in flight finishes (≤ `SHUTDOWN_GRACE_MS`); unstarted messages are released (`VisibilityTimeout 0`); workers finish their tick; HTTP closes; the DB pool closes last.
* **Authentication** is intentionally a no-op `AuthGuard` (`@Public()` keeps health/metrics open). Intended design: an OIDC IdP (e.g. Keycloak/Zitadel); the guard validates the bearer JWT through a `ProviderIdentityPort`, and the token's `provider_id` claim must equal `providerId` in the payload and be the only provider whose transactions can be read. Provider/wallet ownership (which provider may touch which wallet) is not modelled — see limitations.

## 12. Tests and what they prove

| Suite | Runs against | Covers |
|---|---|---|
| `test/unit` (106) | pure code + in-memory doubles | Money, Wallet, ledger, aggregate transitions, every business rule, payload hash, idempotency (sequential and 50-parallel), the 80+80 on 100 scenario, out-of-order resolution/exhaustion, inbox dedup, outbox events/backoff/ordering rule, rollback, reconciliation, pagination |
| `test/integration` | **real PostgreSQL + LocalStack** | every constraint/trigger in §6 (including deferred ledger agreement and reversible migrations); atomicity of the five writes; SQS consumer: redelivery, lost ack after commit, DLQ for permanent errors, backoff then DLQ, recovery, graceful stop; outbox: publish-after-commit, crash then another instance publishes, disjoint `SKIP LOCKED` batches, broker failure retry |
| `test/concurrency` | **3 real OS processes**, one DB, shared queues | 50 identical requests over 3 instances; 80+80; 120 bets on a 100.00 hot wallet (exactly 100 ok, gap-free versions); 30 wallets in parallel; HTTP+SQS racing with duplicate deliveries; out-of-order REFUND/ROLLBACK; `SIGKILL` mid-load; `SIGTERM` graceful exit 0; competing publishers; final global invariant |

In-memory doubles emulate unique constraints, rollback and serialisation only to test *application logic*; concurrency/atomicity guarantees are asserted exclusively against PostgreSQL.

## 13. Limitations / assumptions

* **Throughput on one wallet is bounded by one transaction at a time** (the price of strong consistency); scale comes from many wallets. Shard-by-wallet routing of SQS groups would reduce lock waits further.
* Outbox ordering is per-wallet *best effort across publishers* (see §8); consumers should use `walletVersion`.
* The FIFO deduplication window (5 min) is not relied upon; correctness comes from the inbox and idempotency key.
* Authorization of provider ⇄ wallet is not implemented; any caller can submit for any wallet.
* Currency code is validated by shape (`^[A-Z]{3}$`), not against the ISO-4217 list.
* No wallet closing, no partial reversals, no transaction archiving/partitioning of the ledger (a production ledger would be partitioned by time).
* MikroORM migrations are not guarded by an advisory lock: run `migrate` once per deploy (compose does).
* LocalStack is pinned to `3.8.1` because newer images may require an auth token.
