import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { AppConfig, QueueNames } from '../../config/config';

export function createSqsClient(aws: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: aws.region,
    ...(aws.endpoint ? { endpoint: aws.endpoint } : {}),
    ...(aws.accessKeyId && aws.secretAccessKey
      ? { credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey } }
      : {}),
  });
}

export interface QueueUrls {
  transactions: string;
  transactionsDlq: string;
  events: string;
}

/**
 * Idempotent infrastructure bootstrap (run by `bun run migrate` and by tests): creates the FIFO
 * queues and wires the redrive policy. Safe to run from several processes at once.
 *
 * The queue-level redrive (`maxReceiveCount` + 2) is only a safety net: the consumer applies its
 * own limit first and sends to the DLQ explicitly, so it can also DLQ *permanent* errors at once.
 */
export async function ensureQueues(
  client: SQSClient,
  names: QueueNames,
  options: { maxReceiveCount: number; visibilityTimeoutSeconds: number },
): Promise<QueueUrls> {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: names.transactionsDlq,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600' },
    }),
  );
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl as string, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttributes.Attributes?.['QueueArn'] as string;

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: names.transactions,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(options.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: options.maxReceiveCount + 2 }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({
      QueueName: names.events,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  return {
    transactions: main.QueueUrl as string,
    transactionsDlq: dlq.QueueUrl as string,
    events: events.QueueUrl as string,
  };
}

export async function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const out = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  return out.QueueUrl as string;
}
