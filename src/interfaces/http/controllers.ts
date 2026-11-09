import { Body, Controller, Get, Header, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { WalletQueries } from '../../application/queries';
import { SubmitWagerTransactionUseCase } from '../../application/submit-wager-transaction.use-case';
import { HealthService } from '../../infrastructure/health';
import { currentCorrelationId } from '../../infrastructure/observability/request-context';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';
import { METRICS } from '../../tokens';
import { Public } from './auth';
import {
  presentLedgerEntry,
  presentSubmitResult,
  presentTransaction,
  presentWallet,
  submitStatusCode,
} from './presenters';

const correlationId = (): string => currentCorrelationId() ?? 'unknown';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  async create(@Body() body: Record<string, unknown> | undefined, @Res({ passthrough: true }) res: Response) {
    const wallet = await this.createWallet.execute({
      playerId: body?.['playerId'],
      initialBalance: body?.['initialBalance'],
      correlationId: correlationId(),
    });
    res.status(201);
    res.setHeader('Location', `/wallets/${wallet.id}`);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return presentWallet(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const page = await this.queries.getLedger(walletId, cursor, limit);
    return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  /** Read-only check: never "fixes" anything. Divergences are logged, counted and flagged. */
  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string, @Res({ passthrough: true }) res: Response) {
    res.status(200);
    return this.queries.reconcile(walletId);
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.submit.execute({
      idempotencyKey,
      data: body,
      correlationId: correlationId(),
      source: 'http',
    });
    if (result.type !== 'RESULT') throw new Error('unreachable: HTTP submissions carry no inbox message');

    const { transaction, idempotentReplay } = result;
    res.status(submitStatusCode(transaction, idempotentReplay));
    res.setHeader('Location', `/wagering/transactions/${transaction.id}`);
    return presentSubmitResult(transaction, idempotentReplay);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return presentTransaction(await this.queries.getTransactionById(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return presentTransaction(await this.queries.getTransactionByExternalId(providerId, externalTransactionId));
  }
}

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'up' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness();
    res.status(report.ready ? 200 : 503);
    return report;
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
