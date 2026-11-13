import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { AppError } from '../shared/errors.js';

const ADVISORY_LOCK_KEY = 872413;
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../../database/migrations', import.meta.url));

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  checksum: string;
  applied: boolean;
  checksumMismatch: boolean;
  appliedAt?: string;
}

async function ensureHistoryTable(queryable: Pick<pg.Pool | pg.PoolClient, 'query'>): Promise<void> {
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL
    )
  `);
}

export async function listMigrations(directory = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^\d+_[a-z0-9_-]+\.sql$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set<string>();
  const migrations: MigrationFile[] = [];
  for (const entry of files) {
    const version = entry.name.split('_')[0];
    if (!version || seen.has(version)) {
      throw new AppError(500, 'MIGRATION_VERSION_CONFLICT', `Duplicate migration version in ${entry.name}`);
    }
    seen.add(version);
    const filename = path.join(directory, entry.name);
    const sql = await fs.readFile(filename, 'utf8');
    migrations.push({
      version,
      name: entry.name.replace(/\.sql$/i, ''),
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex')
    });
  }
  return migrations;
}

async function appliedMigrations(queryable: Pick<pg.Pool | pg.PoolClient, 'query'>) {
  const result = await queryable.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  return new Map(result.rows.map((row) => [row.version, row]));
}

export async function migrationStatus(pool: pg.Pool, directory = DEFAULT_MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  await ensureHistoryTable(pool);
  const [files, applied] = await Promise.all([listMigrations(directory), appliedMigrations(pool)]);
  return files.map((file) => {
    const appliedRow = applied.get(file.version);
    return {
      version: file.version,
      name: file.name,
      checksum: file.checksum,
      applied: Boolean(appliedRow),
      checksumMismatch: Boolean(appliedRow && appliedRow.checksum !== file.checksum),
      ...(appliedRow ? { appliedAt: appliedRow.applied_at.toISOString() } : {})
    };
  });
}

export async function applyMigrations(pool: pg.Pool, directory = DEFAULT_MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureHistoryTable(client);
    const files = await listMigrations(directory);
    const applied = await appliedMigrations(client);

    for (const file of files) {
      const appliedRow = applied.get(file.version);
      if (appliedRow) {
        if (appliedRow.checksum !== file.checksum) {
          throw new AppError(500, 'MIGRATION_CHECKSUM_MISMATCH', `Migration ${file.name} was modified after being applied`);
        }
        continue;
      }

      const startedAt = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [file.version, file.name, file.checksum, Date.now() - startedAt]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return migrationStatus(pool, directory);
}
