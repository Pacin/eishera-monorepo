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
  return (await getPlayerSummaries([playerId])).get(playerId) ?? null;
}

/**
 * Batch variant: build summaries for many players in a fixed 3 queries (not 3×N).
 * The tick loop uses this to push `player:update` to every online active player
 * each tick without a per-player query storm.
 */
export async function getPlayerSummaries(ids: number[]): Promise<Map<number, PlayerSummary>> {
  const out = new Map<number, PlayerSummary>();
  if (ids.length === 0) return out;
  const cfg = getConfig();

  const players = await query(
    `SELECT id, username, gold, tokens, actions_remaining, max_actions, str, vit, def, eva, dex, luck,
            active_recipe_id, active_monster_id
       FROM players WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  const skillsRes = await query(
    'SELECT player_id, skill_id, level, xp FROM player_skills WHERE player_id = ANY($1::bigint[])',
    [ids],
  );
  const housingRes = await query(
    'SELECT player_id, feature_id, level FROM player_housing WHERE player_id = ANY($1::bigint[])',
    [ids],
  );

  const skillsByPlayer = new Map<number, PlayerSummary['skills']>();
  for (const s of skillsRes.rows as any[]) {
    const pid = Number(s.player_id);
    const list = skillsByPlayer.get(pid) ?? [];
    list.push({
      code: cfg.skills.get(s.skill_id)?.code ?? `skill:${s.skill_id}`,
      level: s.level,
      xp: Number(s.xp),
    });
    skillsByPlayer.set(pid, list);
  }
  const housingByPlayer = new Map<number, PlayerSummary['housing']>();
  for (const h of housingRes.rows as any[]) {
    const pid = Number(h.player_id);
    const list = housingByPlayer.get(pid) ?? [];
    list.push({
      code: cfg.housingFeatures.get(h.feature_id)?.code ?? `feature:${h.feature_id}`,
      level: h.level,
    });
    housingByPlayer.set(pid, list);
  }

  for (const row of players.rows as any[]) {
    const id = Number(row.id);
    out.set(id, {
      id,
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
      skills: skillsByPlayer.get(id) ?? [],
      housing: housingByPlayer.get(id) ?? [],
      active_recipe_id: row.active_recipe_id === null ? null : Number(row.active_recipe_id),
      active_monster_id: row.active_monster_id === null ? null : Number(row.active_monster_id),
    });
  }
  return out;
}
