// Postgres connection — the single source of truth (SPEC §2.1).
// A single shared pool for the process. Authoritative reads/writes go through
// here; later phases add the tick transaction, market matching, etc., all on top
// of this pool. No game logic lives in this file.

import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { env } from '../config/env.js';

export const pool = new Pool({ connectionString: env.databaseUrl });

/** Run a single parameterized query on a pooled connection. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
) {
  return pool.query<T>(text, params as unknown[] | undefined);
}

/**
 * Run `fn` inside one BEGIN/COMMIT transaction, rolling back on any error.
 * This is the seam the tick loop (SPEC §6) and market matching (SPEC §10) build
 * on — every tick is exactly one transaction.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Liveness probe: confirms the pool can reach Postgres. */
export async function healthcheck(): Promise<boolean> {
  const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

/** Close the pool on shutdown. */
export function closePool(): Promise<void> {
  return pool.end();
}
