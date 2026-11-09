import { OutboxMessage } from '../messaging/domain/outbox-message';
import { Clock, EventPublisher, Logger, Metrics, UnitOfWork } from './ports';

/**
 * Drains the transactional outbox.
 *
 * A batch is claimed with `FOR UPDATE SKIP LOCKED` inside a SQL transaction, published, and the
 * rows marked in that same transaction. Consequences:
 *  - concurrent publishers receive disjoint batches (no contention, no double claim);
 *  - a publisher that dies mid-batch rolls back, the row locks vanish and another instance
 *    re-publishes: delivery is AT-LEAST-ONCE, and consumers dedupe on `eventId`
 *    (also used as the FIFO MessageDeduplicationId);
 *  - nothing is published before the business transaction that produced it has committed,
 *    because rows only become visible to `claimDue` after that commit.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  /** Returns the number of messages claimed (published or rescheduled). */
  async execute(batchSize: number): Promise<number> {
    const claimed = await this.uow.run(async (repos) => {
      const now = this.clock.now();
      const messages = await repos.outbox.claimDue(now, batchSize);
      if (messages.length === 0) return 0;

      // Per partition key (wallet): publish in order and stop at the first failure so a later
      // event never overtakes an earlier one. Different partitions publish in parallel.
      const groups = new Map<string, OutboxMessage[]>();
      for (const message of messages) {
        const group = groups.get(message.partitionKey);
        if (group) group.push(message);
        else groups.set(message.partitionKey, [message]);
      }

      const published: OutboxMessage[] = [];
      const failed: OutboxMessage[] = [];
      await Promise.all(
        [...groups.values()].map(async (group) => {
          for (const message of group) {
            try {
              await this.publisher.publish(message);
              published.push(message);
            } catch (error) {
              failed.push(message);
              this.logger.warn('outbox publish failed', {
                outboxId: message.id,
                eventType: message.eventType,
                attempts: message.attempts + 1,
                error: error instanceof Error ? error.message : String(error),
              });
              break;
            }
          }
        }),
      );

      const at = this.clock.now();
      for (const message of published) {
        message.markPublished(at);
        await repos.outbox.save(message);
      }
      for (const message of failed) {
        message.scheduleRetry(at);
        await repos.outbox.save(message);
        this.metrics.retry('outbox_publish');
      }
      this.metrics.outboxPublished(published.length);
      return messages.length;
    });

    await this.refreshStats();
    return claimed;
  }

  private async refreshStats(): Promise<void> {
    try {
      const stats = await this.uow.run((repos) => repos.outbox.stats(this.clock.now()));
      this.metrics.outboxStats(stats);
    } catch {
      // Observability must never break the publisher.
    }
  }
}
