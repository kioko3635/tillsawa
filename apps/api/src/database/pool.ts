import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { AppConfig } from '../config/env.js';

const { Pool } = pg;
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/**
 * Request-scoped tenant context propagated to PostgreSQL connections. The
 * authentication middleware populates it via `enterWith` immediately after the
 * bearer token is verified; downstream `query`/`connect` calls on
 * TenantScopedPool inherit it for the lifetime of the request.
 */
export interface TenantRequestContext {
  organizationId: string;
}

export const tenantRequestStore = new AsyncLocalStorage<TenantRequestContext>();

function poolConfig(config: AppConfig, databaseUrl: string): pg.PoolConfig {
  return {
    connectionString: databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10
  };
}

export function createPool(config: AppConfig, databaseUrl = config.databaseUrl): pg.Pool {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool(poolConfig(config, databaseUrl));
}

export function roleFromUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  try {
    const user = decodeURIComponent(new URL(databaseUrl).username);
    return /^[a-z_][a-z0-9_]*$/i.test(user) ? user : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Dedicated pool for the privileged system path: pre-authentication identity
 * flows (registration, login, refresh, logout, password reset), the
 * cross-tenant user-email lookup in user invites, migrations and disposable
 * test-schema setup.
 *
 * Privilege is bound to the authenticated login, not a session flag: the pool
 * connects as the `pos_system` role via DATABASE_SYSTEM_URL, and
 * `pos_is_system()` checks `pg_has_role(session_user, 'pos_system', 'member')`.
 * The ordinary runtime role cannot reach this state — it holds no pos_system
 * membership, so SET ROLE and SET SESSION AUTHORIZATION into it are rejected.
 *
 * Connections run `-c role=<ownerRole>` (the application/schema-owner role) so
 * objects created on this path keep the same owner as tenant-path objects and
 * the system role exercises only the application role's privileges plus its
 * RLS exemption. session_user remains pos_system, which is what the policies
 * evaluate. Never expose this pool to authenticated request handlers; see
 * docs/tenant-isolation.md.
 *
 * `pos.system_access=on` is retained only for transition compatibility: a
 * fresh database replays migration 20261020000100 (which still evaluates the
 * flag while its own schema_migrations row is recorded). Once
 * 20261021000100 applies, no policy reads the flag — it is inert.
 */
export function createSystemPool(config: AppConfig, databaseUrl = config.databaseSystemUrl ?? config.databaseUrl, ownerRole = roleFromUrl(config.databaseUrl)): pg.Pool {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool({
    ...poolConfig(config, databaseUrl),
    options: `-c pos.system_access=on${ownerRole ? ` -c role=${ownerRole}` : ''}`
  });
}

/**
 * A real pg.Pool whose `connect`/`query` are instrumented so every checkout
 * binds `pos.organization_id` from the request's AsyncLocalStorage store before
 * any work runs. The GUC is unconditionally overwritten at checkout (empty when
 * no tenant context exists), so a pooled connection can never retain a previous
 * request's tenant context and missing context fails closed under row-level
 * security.
 */
export function createTenantPool(config: AppConfig, databaseUrl = config.databaseUrl): pg.Pool {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = new Pool(poolConfig(config, databaseUrl));
  const baseConnect = pool.connect.bind(pool);
  const scopedConnect = async (): Promise<pg.PoolClient> => {
    const client = await baseConnect();
    try {
      await client.query(`SELECT set_config('pos.organization_id', $1::text, false)`, [
        tenantRequestStore.getStore()?.organizationId ?? ''
      ]);
    } catch (error) {
      client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return client;
  };
  pool.connect = scopedConnect as pg.Pool['connect'];
  pool.query = (async (queryTextOrConfig: string | pg.QueryConfig<unknown[]>, values?: unknown[]) => {
    const client = await scopedConnect();
    try {
      return typeof queryTextOrConfig === 'string'
        ? await client.query(queryTextOrConfig, values)
        : await client.query(queryTextOrConfig);
    } finally {
      client.release();
    }
  }) as pg.Pool['query'];
  return pool;
}

export async function withTransaction<T>(client: pg.Pool | pg.PoolClient, callback: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const ownsClient = !('release' in client);
  const tx: pg.PoolClient = ownsClient ? await client.connect() : client;
  try {
    await tx.query('BEGIN');
    const result = await callback(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (ownsClient) tx.release();
  }
}
