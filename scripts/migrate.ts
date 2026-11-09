/**
 * `bun run migrate`       → applies pending migrations AND creates the SQS queues (idempotent).
 * `bun run migrate:down`  → reverts the last migration (or all with `down all`).
 * Run it once per deployment (docker-compose has a one-shot `migrate` service), not from every replica.
 */
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig, queueNames } from '../src/config/config';
import { mikroOrmOptions } from '../src/infrastructure/persistence/mikro-orm.config';
import { createSqsClient, ensureQueues } from '../src/infrastructure/sqs/sqs-client';

export async function migrate(direction: 'up' | 'down', scope?: string): Promise<void> {
  const config = loadConfig();
  const orm = await MikroORM.init(mikroOrmOptions(config.database));
  try {
    const migrator = new Migrator(orm.em);
    if (direction === 'up') {
      const applied = await migrator.up();
      console.log(`migrations applied: ${applied.length}`);
      const sqs = createSqsClient(config.aws);
      await ensureQueues(sqs, queueNames(config.sqs.queuePrefix), {
        maxReceiveCount: config.sqs.maxReceiveCount,
        visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
      });
      sqs.destroy();
      console.log('sqs queues ensured');
    } else {
      const reverted = scope === 'all' ? await migrator.down({ to: 0 }) : await migrator.down();
      console.log(`migrations reverted: ${reverted.length}`);
    }
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  migrate(direction, process.argv[3]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
