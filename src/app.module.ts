import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { Clock, EventPublisher, IdGenerator, Logger, Metrics, UnitOfWork } from './application/ports';
import { ProcessPendingReferencesUseCase } from './application/process-pending-references.use-case';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case';
import { WalletQueries } from './application/queries';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { TransactionEffects } from './application/transaction-effects';
import { AppConfig, queueNames } from './config/config';
import { HealthService } from './infrastructure/health';
import { BackgroundRoles, DatabaseLifecycle } from './infrastructure/lifecycle';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { mikroOrmOptions } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/unit-of-work';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { AuthGuard } from './interfaces/http/auth';
import {
  HealthController,
  MetricsController,
  WageringController,
  WalletsController,
} from './interfaces/http/controllers';
import { AllExceptionsFilter } from './interfaces/http/error-filter';
import { uuidv7 } from './shared/ids';
import { WagerProcessor } from './wagering/domain/wager-processor';
import {
  APP_CONFIG, CLOCK, EVENT_PUBLISHER, ID_GENERATOR, LOGGER, METRICS, ORM, SQS_CLIENT, UNIT_OF_WORK,
} from './tokens';

@Module({})
export class AppModule {
  /** Composition root: every port is bound to its adapter here (and only here). */
  static register(config: AppConfig): DynamicModule {
    const names = queueNames(config.sqs.queuePrefix);

    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: new JsonLogger() },
        { provide: METRICS, useValue: new PrometheusMetrics() },
        { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
        { provide: ID_GENERATOR, useValue: { next: () => uuidv7() } satisfies IdGenerator },
        { provide: ORM, useFactory: async () => MikroORM.init(mikroOrmOptions(config.database)) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.aws) },
        {
          provide: UNIT_OF_WORK,
          inject: [ORM, METRICS, LOGGER],
          useFactory: (orm: MikroORM, metrics: Metrics, logger: Logger): UnitOfWork =>
            new MikroOrmUnitOfWork(orm, config.database.lockTimeoutMs, metrics, logger),
        },
        {
          provide: EVENT_PUBLISHER,
          inject: [SQS_CLIENT],
          useFactory: (sqs: SQSClient): EventPublisher => new SqsEventPublisher(sqs, names.events),
        },
        { provide: WagerProcessor, useFactory: () => new WagerProcessor() },
        {
          provide: TransactionEffects,
          inject: [ID_GENERATOR],
          useFactory: (ids: IdGenerator) => new TransactionEffects(ids),
        },
        {
          provide: SubmitWagerTransactionUseCase,
          inject: [UNIT_OF_WORK, WagerProcessor, TransactionEffects, CLOCK, ID_GENERATOR, METRICS, LOGGER],
          useFactory: (
            uow: UnitOfWork, processor: WagerProcessor, effects: TransactionEffects, clock: Clock,
            ids: IdGenerator, metrics: Metrics, logger: Logger,
          ) => new SubmitWagerTransactionUseCase(uow, processor, effects, clock, ids, metrics, logger, config.pendingReference),
        },
        {
          provide: CreateWalletUseCase,
          inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, LOGGER],
          useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, logger: Logger) =>
            new CreateWalletUseCase(uow, clock, ids, logger),
        },
        {
          provide: ProcessPendingReferencesUseCase,
          inject: [UNIT_OF_WORK, WagerProcessor, TransactionEffects, CLOCK, ID_GENERATOR, METRICS, LOGGER],
          useFactory: (
            uow: UnitOfWork, processor: WagerProcessor, effects: TransactionEffects, clock: Clock,
            ids: IdGenerator, metrics: Metrics, logger: Logger,
          ) => new ProcessPendingReferencesUseCase(uow, processor, effects, clock, ids, metrics, logger, config.pendingReference),
        },
        {
          provide: PublishOutboxUseCase,
          inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, METRICS, LOGGER],
          useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, metrics: Metrics, logger: Logger) =>
            new PublishOutboxUseCase(uow, publisher, clock, metrics, logger),
        },
        {
          provide: WalletQueries,
          inject: [UNIT_OF_WORK, METRICS, LOGGER],
          useFactory: (uow: UnitOfWork, metrics: Metrics, logger: Logger) => new WalletQueries(uow, metrics, logger),
        },
        {
          provide: HealthService,
          inject: [ORM, SQS_CLIENT],
          useFactory: (orm: MikroORM, sqs: SQSClient) => new HealthService(orm, sqs, names.transactions),
        },
        BackgroundRoles,
        DatabaseLifecycle,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
