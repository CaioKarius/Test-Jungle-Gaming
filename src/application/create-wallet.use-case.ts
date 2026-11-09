import { WagerTransactionProcessed, WalletBalanceChanged } from '../messaging/domain/events';
import { OutboxMessage } from '../messaging/domain/outbox-message';
import { InvalidMoneyError } from '../shared/domain/errors';
import { Money } from '../shared/domain/money';
import { hashCanonical } from '../shared/canonical';
import { WagerTransaction, WagerTransactionKind } from '../wagering/domain/wager-transaction';
import { Wallet } from '../wallet/domain/wallet';
import { ValidationError, ValidationIssue, WalletAlreadyExistsError } from './errors';
import { Clock, IdGenerator, Logger, UnitOfWork } from './ports';

export interface CreateWalletInput {
  playerId: unknown;
  initialBalance: unknown;
  correlationId: string;
}

export const INTERNAL_PROVIDER_ID = 'internal';

export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const issues: ValidationIssue[] = [];
    const playerId = input.playerId;
    if (typeof playerId !== 'string' || playerId.trim().length === 0 || playerId.length > 128) {
      issues.push({ field: 'playerId', message: 'must be a non-empty string of at most 128 characters' });
    }
    let initialBalance = Money.zero('BRL');
    try {
      initialBalance = Money.from(input.initialBalance as { amount: string; currency: string });
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      issues.push({ field: 'initialBalance', message: error.message });
    }
    if (issues.length > 0) throw new ValidationError('invalid request payload', issues);

    const wallet = await this.uow.run(async (repos) => {
      const now = this.clock.now();
      const wallet = Wallet.open({ id: this.ids.next(), playerId: playerId as string, initialBalance, now });

      if (!(await repos.wallets.insert(wallet))) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }

      // Opening balance: an internal OPENING transaction + CREDIT ledger entry, same SQL transaction.
      if (wallet.balance.isPositive()) {
        const externalTransactionId = `opening:${wallet.id}`;
        const opening = WagerTransaction.create({
          id: this.ids.next(),
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId,
          idempotencyKey: externalTransactionId,
          payloadHash: hashCanonical({ walletId: wallet.id, kind: WagerTransactionKind.Opening, money: wallet.balance.toJSON() }),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'internal',
          kind: WagerTransactionKind.Opening,
          money: wallet.balance,
          createdAt: now,
        });
        opening.observeBalance(wallet.balance);
        opening.markProcessed(undefined, now);

        const entry = wallet.recordOpening({ entryId: this.ids.next(), transactionId: opening.id, now });
        await repos.transactions.insert(opening);
        await repos.ledger.insert(entry);

        const context = () => ({ eventId: this.ids.next(), correlationId: input.correlationId, occurredAt: now });
        await repos.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context())));
        await repos.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context())));
      }
      return wallet;
    });

    this.logger.info('wallet created', { walletId: wallet.id });
    return wallet;
  }
}
