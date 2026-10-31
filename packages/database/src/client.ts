import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { schema } from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

/**
 * One pool per process. `max` stays small so several containers fit in a 1 GB budget:
 * the API needs a handful of connections, the worker one per concurrent job.
 */
export function createDatabase(connectionString: string, overrides: PoolConfig = {}): DatabaseHandle {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'agent-tasks',
    ...overrides,
  });
  pool.on('error', (error) => {
    // A broken idle connection must never crash the process; pg removes it from the pool.
    console.error(JSON.stringify({ level: 'error', event: 'pg_pool_error', message: error.message }));
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
