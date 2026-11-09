import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessPendingReferencesUseCase } from '../application/process-pending-references.use-case';
import { Logger, Metrics } from '../application/ports';
import { PublishOutboxUseCase } from '../application/publish-outbox.use-case';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import { AppConfig, queueNames } from '../config/config';
import { APP_CONFIG, LOGGER, METRICS, ORM, SQS_CLIENT } from '../tokens';
import { PollingWorker } from './workers/polling-worker';
import { SqsWagerConsumer } from './sqs/sqs-consumer';

/**
 * Starts the background roles this instance is configured for and stops them gracefully.
 *
 * Shutdown (SIGTERM → Nest `onModuleDestroy`): stop polling, let in-flight SQS messages / worker
 * ticks finish (bounded by SHUTDOWN_GRACE_MS), release unstarted messages back to the queue.
 * The HTTP server closes after this and the database pool closes last (DatabaseLifecycle).
 */
@Injectable()
export class BackgroundRoles implements OnApplicationBootstrap, OnModuleDestroy {
  private consumer: SqsWagerConsumer | undefined;
  private outboxWorker: PollingWorker | undefined;
  private pendingWorker: PollingWorker | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(PublishOutboxUseCase) private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(ProcessPendingReferencesUseCase) private readonly pendingReferences: ProcessPendingReferencesUseCase,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const { roles, outbox, pendingReference, sqs } = this.config;

    if (roles.outboxPublisher) {
      this.outboxWorker = new PollingWorker(
        'outbox-publisher', outbox.pollIntervalMs, outbox.batchSize,
        () => this.publishOutbox.execute(outbox.batchSize), this.logger,
      );
      this.outboxWorker.start();
    }
    if (roles.pendingReferenceWorker) {
      this.pendingWorker = new PollingWorker(
        'pending-reference-worker', pendingReference.pollIntervalMs, pendingReference.batchSize,
        () => this.pendingReferences.execute(pendingReference.batchSize), this.logger,
      );
      this.pendingWorker.start();
    }
    if (roles.sqsConsumer) {
      this.consumer = new SqsWagerConsumer(
        this.sqs, queueNames(sqs.queuePrefix), sqs, this.submit, this.metrics, this.logger,
      );
      this.consumer.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.consumer?.stop(), this.outboxWorker?.stop(), this.pendingWorker?.stop()]);
  }
}

/** Closes the connection pool and SQS client last, after every role has drained. */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}
