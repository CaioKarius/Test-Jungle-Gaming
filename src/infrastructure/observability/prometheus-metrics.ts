import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Metrics, OutboxStats } from '../../application/ports';

/** Prometheus implementation of the `Metrics` port. One registry per process (scrape every instance). */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total', help: 'Wager transactions by final status and kind',
    labelNames: ['status', 'kind'], registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'duplicates_detected_total', help: 'Duplicate submissions detected (idempotency key or inbox)',
    labelNames: ['source'], registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'retries_total', help: 'Retries by component', labelNames: ['component'], registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'dlq_messages_total', help: 'Messages sent to the dead-letter queue', labelNames: ['reason'], registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total', help: 'Concurrency conflicts (deadlock, lock timeout, version mismatch)',
    labelNames: ['reason'], registers: [this.registry],
  });
  private readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds', help: 'Time spent waiting for a wallet row lock',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5], registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'transaction_processing_duration_seconds', help: 'End-to-end processing latency',
    labelNames: ['source'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: 'outbox_published_total', help: 'Outbox messages published', registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds', help: 'Age of the oldest unpublished outbox message', registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages', help: 'Unpublished outbox messages', registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'reconciliation_divergences_total', help: 'Wallets found inconsistent with their ledger', registers: [this.registry],
  });
  private readonly sqs = new Counter({
    name: 'sqs_messages_total', help: 'SQS messages by outcome', labelNames: ['outcome'], registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionProcessed(status: string, kind: string): void { this.transactions.inc({ status, kind }); }
  duplicateDetected(source: 'idempotency' | 'inbox'): void { this.duplicates.inc({ source }); }
  retry(component: string): void { this.retries.inc({ component }); }
  dlqMessage(reason: string): void { this.dlq.inc({ reason }); }
  lockConflict(reason: string): void { this.lockConflicts.inc({ reason }); }
  walletLockWait(seconds: number): void { this.lockWait.observe(seconds); }
  processingDuration(source: string, seconds: number): void { this.duration.observe({ source }, seconds); }
  outboxPublished(count: number): void { if (count > 0) this.outboxPublishedTotal.inc(count); }
  outboxStats(stats: OutboxStats): void {
    this.outboxLag.set(stats.oldestPendingAgeSeconds);
    this.outboxPending.set(stats.pending);
  }
  reconciliationDivergence(): void { this.divergences.inc(); }
  sqsMessage(outcome: string): void { this.sqs.inc({ outcome }); }
}
