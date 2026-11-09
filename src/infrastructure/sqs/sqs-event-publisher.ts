import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/ports';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { resolveQueueUrl } from './sqs-client';

/**
 * Publishes outbox messages to the events FIFO queue.
 *  - MessageGroupId = partition key (wallet): per-wallet ordering at the broker;
 *  - MessageDeduplicationId = eventId: broker-level dedup inside the 5-minute window.
 * Both are optimisations: consumers must still dedupe on `eventId` (at-least-once).
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    this.queueUrl ??= await resolveQueueUrl(this.client, this.queueName);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.partitionKey,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
