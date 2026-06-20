// Player accounts (SPEC §14 Phase 2). Registration creates the player plus the
// initial per-skill and per-housing-feature rows — all in one transaction, so a
// player never exists with a partial setup. Skills, housing features, and the
// starting action cap come from the live config snapshot (data-driven).

import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import type { PlayerSummary } from '@eishera/shared';

const BCRYPT_COST = 10;

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username already taken: ${username}`);
    this.name = 'UsernameTakenError';
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Create a player with initial skills (level 1) and housing (level 0). */
export async function createPlayer(username: string, password: string): Promise<number> {
  const cfg = getConfig();
  const maxActions = cfg.gameConfig.starting_max_actions;
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  return withTransaction(async (client) => {
    let playerId: number;
    try {
      const res = await client.query(
        `INSERT INTO players (username, password_hash, max_actions, actions_remaining)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [username, passwordHash, maxActions],
      );
      playerId = Number((res.rows[0] as { id: string }).id);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new UsernameTakenError(username);
      throw err;
    }

    for (const skill of cfg.skills.values()) {
      await client.query('INSERT INTO player_skills (player_id, skill_id) VALUES ($1, $2)', [
        playerId,
        skill.id,
      ]);
    }
    for (const feature of cfg.housingFeatures.values()) {
      await client.query('INSERT INTO player_housing (player_id, feature_id) VALUES ($1, $2)', [
        playerId,
        feature.id,
      ]);
    }

    return playerId;
  });
}

/** Return the player id if credentials are valid, otherwise null. */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<number | null> {
  const res = await query('SELECT id, password_hash FROM players WHERE username = $1', [username]);
  const row = res.rows[0] as { id: string; password_hash: string } | undefined;
  if (!row) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  return ok ? Number(row.id) : null;
}

/** Assemble the player-facing summary (player row + skills + housing). */
export async function getPlayerSummary(playerId: number): Promise<PlayerSummary | null> {
  const cfg = getConfig();
  const p = await query(
    `SELECT id, username, gold, tokens, actions_remaining, max_actions, str, vit, def, eva, dex, luck
       FROM players WHERE id = $1`,
    [playerId],
  );
  const row = p.rows[0] as any;
  if (!row) return null;

  const skillsRes = await query(
    'SELECT skill_id, level, xp FROM player_skills WHERE player_id = $1',
    [playerId],
  );
  const housingRes = await query(
    'SELECT feature_id, level FROM player_housing WHERE player_id = $1',
    [playerId],
  );

  return {
    id: Number(row.id),
    username: row.username,
    gold: Number(row.gold),
    tokens: Number(row.tokens),
    actions_remaining: row.actions_remaining,
    max_actions: row.max_actions,
    stats: {
      str: row.str,
      vit: row.vit,
      def: row.def,
      eva: row.eva,
      dex: row.dex,
      luck: row.luck,
    },
    skills: (skillsRes.rows as any[]).map((s) => ({
      code: cfg.skills.get(s.skill_id)?.code ?? `skill:${s.skill_id}`,
      level: s.level,
      xp: Number(s.xp),
    })),
    housing: (housingRes.rows as any[]).map((h) => ({
      code: cfg.housingFeatures.get(h.feature_id)?.code ?? `feature:${h.feature_id}`,
      level: h.level,
    })),
  };
}
