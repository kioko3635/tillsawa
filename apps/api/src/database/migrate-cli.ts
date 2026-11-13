import { loadConfig } from '../config/env.js';
import { applyMigrations, migrationStatus } from './migrator.js';
import { createSystemPool, roleFromUrl } from './pool.js';

async function main(): Promise<void> {
  const [command = 'apply'] = process.argv.slice(2);
  const useTestDatabase = process.argv.includes('--test');
  const config = loadConfig();
  const databaseUrl = useTestDatabase ? config.testDatabaseUrl : config.databaseUrl;
  if (!databaseUrl) {
    throw new Error(`${useTestDatabase ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is required`);
  }

  // Migrations need the privileged system identity (session_user=pos_system)
  // for catalog seeds and cross-tenant backfills. Without a dedicated
  // *_DATABASE_SYSTEM_URL the connection falls back to the ordinary role and
  // RLS fails closed rather than silently widening access.
  const systemUrl = useTestDatabase
    ? config.testDatabaseSystemUrl ?? config.testDatabaseUrl
    : config.databaseSystemUrl ?? config.databaseUrl;
  const pool = createSystemPool(config, systemUrl, roleFromUrl(databaseUrl));
  try {
    const result = command === 'status' ? await migrationStatus(pool) : await applyMigrations(pool);
    for (const migration of result) {
      const state = migration.checksumMismatch ? 'CHECKSUM_MISMATCH' : migration.applied ? 'APPLIED' : 'PENDING';
      console.log(`${state}\t${migration.name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
