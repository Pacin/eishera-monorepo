// Opaque refresh tokens with rotation + revocation, backed by Postgres
// (auth_refresh_tokens). The raw token is a 256-bit random secret; only its
// SHA-256 hash is stored. Each refresh rotates: the presented token is revoked
// and a new one issued. Presenting an already-revoked token is treated as theft
// (reuse) and revokes the player's whole token family.

import { randomBytes, createHash } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';

export class InvalidRefreshError extends Error {
  constructor() {
    super('Invalid or expired refresh token');
    this.name = 'InvalidRefreshError';
  }
}

export class ReusedRefreshError extends Error {
  constructor(public readonly playerId: number) {
    super('Refresh token reuse detected; all sessions revoked');
    this.name = 'ReusedRefreshError';
  }
}

const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const newRaw = (): string => randomBytes(32).toString('base64url');
const expiryDate = (): Date => new Date(Date.now() + env.refreshTtlDays * 24 * 60 * 60 * 1000);

/** Mint a new refresh token for a player and persist its hash. Returns the raw token. */
export async function issueRefreshToken(playerId: number): Promise<string> {
  const raw = newRaw();
  await query(
    'INSERT INTO auth_refresh_tokens (player_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [playerId, sha256(raw), expiryDate()],
  );
  return raw;
}

/** Validate + rotate a refresh token. Throws on invalid/expired/reused. */
export async function rotateRefreshToken(
  rawOld: string,
): Promise<{ playerId: number; rawNew: string }> {
  const hashOld = sha256(rawOld);
  return withTransaction(async (client) => {
    const res = await client.query(
      'SELECT id, player_id, expires_at, revoked_at FROM auth_refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [hashOld],
    );
    const row = res.rows[0] as
      | { id: string; player_id: string; expires_at: string; revoked_at: string | null }
      | undefined;
    if (!row) throw new InvalidRefreshError();
    const playerId = Number(row.player_id);

    if (row.revoked_at !== null) {
      // A revoked token was replayed → likely theft. Revoke the whole family.
      await client.query(
        'UPDATE auth_refresh_tokens SET revoked_at = now() WHERE player_id = $1 AND revoked_at IS NULL',
        [playerId],
      );
      throw new ReusedRefreshError(playerId);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new InvalidRefreshError();

    await client.query('UPDATE auth_refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);

    const rawNew = newRaw();
    await client.query(
      'INSERT INTO auth_refresh_tokens (player_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [playerId, sha256(rawNew), expiryDate()],
    );
    return { playerId, rawNew };
  });
}

/** Revoke a single refresh token (logout of the current session). */
export async function revokeRefreshToken(raw: string): Promise<void> {
  await query(
    'UPDATE auth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256(raw)],
  );
}
