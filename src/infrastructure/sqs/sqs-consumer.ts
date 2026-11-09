import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Logger, Metrics } from '../../application/ports';
import { SubmitWagerTransactionUseCase } from '../../application/submit-wager-transaction.use-case';
import { AppConfig, QueueNames } from '../../config/config';
import { errorMessage } from '../persistence/pg-errors';
import { runWithContext } from '../observability/request-context';
import {
  CONSUMER_NAME,
  ParsedMessage,
  classifyError,
  errorReason,
  parseEnvelope,
  retryDelaySeconds,
} from './message-handling';
import { resolveQueueUrl } from './sqs-client';

type Decision =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number; reason: string }
  | { action: 'dlq'; reason: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SQS FIFO consumer. Reuses the SAME use case as the HTTP entry point and relies on the persistent
 * inbox + idempotency key — never on FIFO ordering/dedup — for correctness.
 *
 * Ack discipline: a message is deleted only AFTER the use case's SQL transaction has committed.
 * If the process dies between commit and delete, the message is redelivered and the inbox turns
 * it into a no-op.
 *
 * Outcomes: business result → ack; permanent error → DLQ (then delete); transient error → change
 * visibility with exponential backoff, DLQ once `maxReceiveCount` attempts are used up.
 */
export class SqsWagerConsumer {
  private stopping = false;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private queueUrl = '';
  private dlqUrl = '';

  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueNames,
    private readonly config: AppConfig['sqs'],
    private readonly useCase: SubmitWagerTransactionUseCase,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  /** Stops polling, lets in-flight messages finish (bounded by the grace period), releases the rest. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (!this.loop) return;
    const timeout = sleep(this.config.shutdownGraceMs).then(() => 'timeout' as const);
    const outcome = await Promise.race([this.loop.then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      this.logger.warn('sqs consumer did not drain within the grace period; unacked messages will be redelivered');
    }
  }

  private async run(): Promise<void> {
    try {
      this.queueUrl = await this.withRetry(() => resolveQueueUrl(this.client, this.queues.transactions));
      this.dlqUrl = await this.withRetry(() => resolveQueueUrl(this.client, this.queues.transactionsDlq));
    } catch {
      return; // stopped while waiting for the queues
    }
    this.logger.info('sqs consumer started', { queue: this.queues.transactions });

    while (!this.stopping) {
      let messages: Message[];
      try {
        const out = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.config.batchSize,
            WaitTimeSeconds: this.config.waitTimeSeconds,
            MessageSystemAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (error) {
        if (this.stopping) break;
        this.logger.warn('sqs receive failed', { error: errorMessage(error) });
        await sleep(1000);
        continue;
      }
      await this.processBatch(messages);
    }
    this.logger.info('sqs consumer stopped');
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      if (this.stopping) throw new Error('stopped');
      try {
        return await fn();
      } catch (error) {
        this.logger.warn('waiting for sqs queues', { error: errorMessage(error) });
        await sleep(1000);
      }
    }
  }

  /** Same MessageGroupId ⇒ sequential, in broker order; different groups ⇒ parallel. */
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const key = message.Attributes?.['MessageGroupId'] ?? message.MessageId ?? 'none';
      const group = groups.get(key);
      if (group) group.push(message);
      else groups.set(key, [message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) {
            await this.release(message); // not started: hand it back immediately
          } else {
            await this.handle(message);
          }
        }
      }),
    );
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1');
    let parsed: ParsedMessage | undefined;
    try {
      parsed = parseEnvelope(message.Body);
    } catch {
      // handled below through decide()
    }

    await runWithContext(
      {
        correlationId: parsed?.messageId ?? message.MessageId,
        messageId: parsed?.messageId ?? message.MessageId,
        walletId: typeof parsed?.data['walletId'] === 'string' ? (parsed.data['walletId'] as string) : undefined,
        providerId: typeof parsed?.data['providerId'] === 'string' ? (parsed.data['providerId'] as string) : undefined,
      },
      async () => {
        const decision = await this.decide(message, receiveCount);
        await this.apply(message, decision, receiveCount);
      },
    );
  }

  private async decide(message: Message, receiveCount: number): Promise<Decision> {
    try {
      const parsed = parseEnvelope(message.Body);
      await this.useCase.execute({
        idempotencyKey: parsed.idempotencyKey,
        data: parsed.data,
        correlationId: parsed.messageId,
        causationId: parsed.messageId,
        source: 'sqs',
        inbox: { messageId: parsed.messageId, consumerName: CONSUMER_NAME, payloadHash: parsed.inboxPayloadHash },
      });
      return { action: 'ack' }; // RESULT (incl. REJECTED / replay) or DUPLICATE_MESSAGE: all final
    } catch (error) {
      const reason = errorReason(error);
      if (classifyError(error) === 'permanent') {
        this.logger.error('permanent failure, sending to DLQ', { reason, error: errorMessage(error) });
        return { action: 'dlq', reason };
      }
      if (receiveCount >= this.config.maxReceiveCount) {
        this.logger.error('retry budget exhausted, sending to DLQ', { reason, receiveCount, error: errorMessage(error) });
        return { action: 'dlq', reason: 'MAX_RECEIVE_COUNT_EXCEEDED' };
      }
      this.logger.warn('transient failure, will retry', { reason, receiveCount, error: errorMessage(error) });
      return {
        action: 'retry',
        reason,
        delaySeconds: retryDelaySeconds(receiveCount, this.config.retryBaseSeconds, this.config.retryMaxSeconds),
      };
    }
  }

  private async apply(message: Message, decision: Decision, receiveCount: number): Promise<void> {
    try {
      switch (decision.action) {
        case 'ack':
          await this.delete(message);
          this.metrics.sqsMessage('acked');
          return;
        case 'dlq':
          await this.sendToDlq(message, decision.reason, receiveCount);
          await this.delete(message);
          this.metrics.dlqMessage(decision.reason);
          this.metrics.sqsMessage('dlq');
          return;
        case 'retry':
          await this.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: decision.delaySeconds,
            }),
          );
          this.metrics.retry('sqs_visibility');
          this.metrics.sqsMessage('retry');
          return;
      }
    } catch (error) {
      // Could not ack / DLQ / change visibility. Leaving the message alone is safe: it becomes
      // visible again and the inbox / idempotency key make the redelivery a no-op.
      this.logger.error('failed to settle sqs message; it will be redelivered', { error: errorMessage(error) });
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(message: Message): Promise<void> {
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
      );
      this.metrics.sqsMessage('released');
    } catch (error) {
      this.logger.warn('failed to release message on shutdown', { error: errorMessage(error) });
    }
  }

  private async sendToDlq(message: Message, reason: string, receiveCount: number): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.['MessageGroupId'] ?? 'dlq',
        // SQS MessageId is stable across redeliveries: re-sending after a failed delete is deduplicated.
        MessageDeduplicationId: `dlq:${message.MessageId ?? 'unknown'}`,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
        },
      }),
    );
  }
}

