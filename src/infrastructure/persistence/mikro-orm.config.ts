import { defineConfig } from '@mikro-orm/postgresql';
import { AppConfig } from '../../config/config';
import { Migration20260801000000 } from './migrations/Migration20260801000000_initial';

/**
 * MikroORM is used here as the connection pool, transaction manager (`em.transactional`) and
 * migration runner. The financial hot path issues explicit SQL through `em.execute` inside that
 * transaction: pessimistic row locks, `ON CONFLICT`, `SKIP LOCKED` and exact `numeric` handling
 * are clearer and safer as SQL than through the Unit of Work. See ARCHITECTURE.md §ORM.
 * Domain classes are mapped by hand in repositories.ts, so the domain never depends on the ORM.
 */
export function mikroOrmOptions(database: AppConfig['database']) {
  return defineConfig({
    clientUrl: database.url,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: database.poolMin, max: database.poolMax, acquireTimeoutMillis: 10_000 },
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      migrationsList: [{ name: 'Migration20260801000000_initial', class: Migration20260801000000 }],
    },
    allowGlobalContext: false,
    // MikroORM keeps its own logger off; we log structured JSON ourselves.
    debug: false,
  });
}
