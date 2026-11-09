import { CreateWalletUseCase } from '../../src/application/create-wallet.use-case';
import { PendingReferencePolicy, noopLogger, noopMetrics } from '../../src/application/ports';
import { ProcessPendingReferencesUseCase } from '../../src/application/process-pending-references.use-case';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case';
import { WalletQueries } from '../../src/application/queries';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { TransactionEffects } from '../../src/application/transaction-effects';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { WagerProcessor } from '../../src/wagering/domain/wager-processor';
import { FakeClock, InMemoryDatabase, SequentialIds } from './in-memory';

export const POLICY: PendingReferencePolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  maxAttempts: 4,
  ttlMs: 60_000,
};

export function buildUnitHarness() {
  const db = new InMemoryDatabase();
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const processor = new WagerProcessor();
  const effects = new TransactionEffects(ids);
  const published: OutboxMessage[] = [];
  let publishShouldFail = false;

  const submit = new SubmitWagerTransactionUseCase(
    db.unitOfWork,
    processor,
    effects,
    clock,
    ids,
    noopMetrics,
    noopLogger,
    POLICY,
  );
  const createWallet = new CreateWalletUseCase(db.unitOfWork, clock, ids, noopLogger);
  const pending = new ProcessPendingReferencesUseCase(
    db.unitOfWork,
    processor,
    effects,
    clock,
    ids,
    noopMetrics,
    noopLogger,
    POLICY,
  );
  const publishOutbox = new PublishOutboxUseCase(
    db.unitOfWork,
    {
      publish: async (m) => {
        if (publishShouldFail) throw new Error('broker down');
        published.push(m);
      },
    },
    clock,
    noopMetrics,
    noopLogger,
  );
  const queries = new WalletQueries(db.unitOfWork, noopMetrics, noopLogger);

  return {
    db,
    clock,
    submit,
    createWallet,
    pending,
    publishOutbox,
    queries,
    published,
    setPublishFailing(value: boolean) {
      publishShouldFail = value;
    },
  };
}

export type UnitHarness = ReturnType<typeof buildUnitHarness>;

export const PLAYER = 'player-1';

export async function openWallet(h: UnitHarness, amount = '100.00', playerId = PLAYER, currency = 'BRL') {
  return h.createWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: 'test',
  });
}

export interface SubmitOverrides {
  externalTransactionId?: string;
  kind?: string;
  amount?: string;
  currency?: string;
  playerId?: string;
  roundId?: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
  providerId?: string;
}

export function body(walletId: string, o: SubmitOverrides = {}) {
  return {
    providerId: o.providerId ?? 'provider-a',
    externalTransactionId: o.externalTransactionId ?? 'tx-1',
    playerId: o.playerId ?? PLAYER,
    walletId,
    roundId: o.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: o.kind ?? 'BET',
    money: { amount: o.amount ?? '25.00', currency: o.currency ?? 'BRL' },
    ...(o.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: o.referenceExternalTransactionId }
      : {}),
  };
}

export function submitInput(walletId: string, o: SubmitOverrides = {}) {
  const data = body(walletId, o);
  return {
    idempotencyKey: o.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`,
    data,
    correlationId: 'test',
    source: 'http' as const,
  };
}
