import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

export function migrationsFolder(): string {
  const candidates = [
    join(here, '..', 'drizzle'),
    join(here, 'drizzle'),
    join(process.cwd(), 'packages', 'database', 'drizzle'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta'))) return candidate;
  }
  throw new Error(`no migrations folder found, looked in: ${candidates.join(', ')}`);
}

export async function runMigrations(connectionString: string): Promise<void> {
  const { db, close } = createDatabase(connectionString, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
  } finally {
    await close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url).then(
    () => console.log('migrations applied'),
    (error: unknown) => {
      console.error('migration failed:', error);
      process.exit(1);
    },
  );
}
