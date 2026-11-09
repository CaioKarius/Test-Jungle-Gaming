import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { errorMessage } from './persistence/pg-errors';
import { resolveQueueUrl } from './sqs/sqs-client';

export interface ReadinessReport {
  ready: boolean;
  checks: { postgres: 'up' | 'down'; sqs: 'up' | 'down' };
  errors?: Record<string, string>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class HealthService {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const errors: Record<string, string> = {};
    const [pg, sqs] = await Promise.allSettled([
      withTimeout(this.orm.em.fork().execute('SELECT 1 AS ok'), 2000),
      withTimeout(
        resolveQueueUrl(this.sqs, this.queueName).then((url) =>
          this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] })),
        ),
        2000,
      ),
    ]);
    if (pg.status === 'rejected') errors['postgres'] = errorMessage(pg.reason);
    if (sqs.status === 'rejected') errors['sqs'] = errorMessage(sqs.reason);
    return {
      ready: pg.status === 'fulfilled' && sqs.status === 'fulfilled',
      checks: { postgres: pg.status === 'fulfilled' ? 'up' : 'down', sqs: sqs.status === 'fulfilled' ? 'up' : 'down' },
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    };
  }
}
