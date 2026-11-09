import type { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrentWalletModificationError, TransientInfrastructureError } from '../../application/errors';
import { Logger, Metrics, Repositories, UnitOfWork } from '../../application/ports';
import { conflictReason, errorMessage, isTransientInfrastructure } from './pg-errors';
import { createRepositories } from './repositories';

const MAX_CONFLICT_ATTEMPTS = 3;
const STATEMENT_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One SQL transaction per `run`, via MikroORM's `em.transactional` on a forked EntityManager
 * (READ COMMITTED + explicit row locks; see ARCHITECTURE.md).
 *
 * - `lock_timeout` / `statement_timeout` are set `LOCAL` to the transaction, so a stuck lock
 *   becomes a retryable error instead of a hung request.
 * - Deadlocks, serialization failures, lock timeouts and version mismatches re-run the WHOLE
 *   transaction (bounded, with jitter). `work` therefore must rebuild its state on every call —
 *   the use cases do, and all inputs are immutable.
 * - Connectivity problems surface as `TransientInfrastructureError` (HTTP 503 / SQS retry).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          await em.execute(`SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`, [
            `${this.lockTimeoutMs}ms`,
            `${STATEMENT_TIMEOUT_MS}ms`,
          ]);
          return work(createRepositories(em));
        });
      } catch (error) {
        const reason =
          error instanceof ConcurrentWalletModificationError ? 'version_mismatch' : conflictReason(error);
        if (reason) {
          this.metrics.lockConflict(reason);
          if (attempt < MAX_CONFLICT_ATTEMPTS) {
            this.metrics.retry('db_conflict');
            this.logger.warn('transaction conflict, retrying', { reason, attempt });
            await sleep(10 * attempt + Math.floor(Math.random() * 40));
            continue;
          }
          throw new TransientInfrastructureError(`database conflict (${reason}) persisted after ${attempt} attempts`, error);
        }
        if (isTransientInfrastructure(error)) {
          throw new TransientInfrastructureError(`database unavailable: ${errorMessage(error)}`, error);
        }
        throw error;
      }
    }
  }
}
