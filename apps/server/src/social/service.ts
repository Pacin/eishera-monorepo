// Social features (SPEC §11 adjacent): player-to-player gold transfers (/wire)
// and private messages (/whisper). Both validate server-side and keep a durable
// Postgres record; the socket handler does live delivery. Gold movement mirrors
// the market's atomic pattern (one transaction, rows locked FOR UPDATE in a
// deterministic order so two mutual /wire calls can't deadlock).

import { query, withTransaction } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import type { WhisperMessage, WireReceipt, WireError, WhisperError } from '@eishera/shared';

interface ChatConfig {
  max_length: number;
  rate_max: number;
  rate_window_seconds: number;
}
const chatConfig = (): ChatConfig => getConfig().raw.get('chat') as ChatConfig;

export type TransferResult =
  | { ok: true; receipt: WireReceipt; fromId: number; toId: number }
  | { error: WireError };

/** Move `amount` gold from one player to another, atomically + audited. */
export async function transferGold(
  fromId: number,
  fromUsername: string,
  toUsernameRaw: string,
  amount: number,
): Promise<TransferResult> {
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'bad_amount' };
  const toUsername = toUsernameRaw.trim();
  if (toUsername.length === 0) return { error: 'unknown_user' };

  return withTransaction(async (client) => {
    const toRes = await client.query('SELECT id, username FROM players WHERE username = $1', [
      toUsername,
    ]);
    const toRow = toRes.rows[0] as { id: string; username: string } | undefined;
    if (!toRow) return { error: 'unknown_user' };
    const toId = Number(toRow.id);
    if (toId === fromId) return { error: 'self' };

    // Lock both player rows in a fixed id order — deterministic ordering means
    // concurrent A→B and B→A transfers can't deadlock.
    const locked = await client.query(
      'SELECT id, gold FROM players WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
      [[fromId, toId]],
    );
    const fromRow = (locked.rows as { id: string; gold: string }[]).find(
      (r) => Number(r.id) === fromId,
    );
    if (!fromRow || Number(fromRow.gold) < amount) return { error: 'insufficient_gold' };

    await client.query('UPDATE players SET gold = gold - $2 WHERE id = $1', [fromId, amount]);
    await client.query('UPDATE players SET gold = gold + $2 WHERE id = $1', [toId, amount]);
    await client.query(
      'INSERT INTO gold_transfers (from_player, to_player, amount) VALUES ($1, $2, $3)',
      [fromId, toId, amount],
    );

    return {
      ok: true as const,
      receipt: { from: fromUsername, to: toRow.username, amount },
      fromId,
      toId,
    };
  });
}

// Per-player sliding window for whispers (ephemeral anti-spam, separate from the
// public-chat window). Memory-only; losing it just resets the window.
const recentWhispers = new Map<number, number[]>();
function whisperRateOk(playerId: number, nowMs: number): boolean {
  const { rate_max, rate_window_seconds } = chatConfig();
  const windowStart = nowMs - rate_window_seconds * 1000;
  const stamps = (recentWhispers.get(playerId) ?? []).filter((t) => t > windowStart);
  if (stamps.length >= rate_max) {
    recentWhispers.set(playerId, stamps);
    return false;
  }
  stamps.push(nowMs);
  recentWhispers.set(playerId, stamps);
  return true;
}

/**
 * Recent whispers involving a player (sent OR received), oldest → newest. Sent
 * on connect so history survives reconnects and an offline recipient catches up
 * on everything that arrived while they were away (delivery is best-effort live,
 * but `direct_messages` is the durable source of truth).
 */
export async function whisperHistory(playerId: number, limit: number): Promise<WhisperMessage[]> {
  const res = await query(
    `SELECT d.id, d.body, d.created_at, pf.username AS from_name, pt.username AS to_name
       FROM direct_messages d
       JOIN players pf ON pf.id = d.from_player
       JOIN players pt ON pt.id = d.to_player
      WHERE d.from_player = $1 OR d.to_player = $1
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $2`,
    [playerId, limit],
  );
  return (res.rows as { id: string; body: string; created_at: Date; from_name: string; to_name: string }[])
    .map((r) => ({
      id: Number(r.id),
      from: r.from_name,
      to: r.to_name,
      body: r.body,
      created_at: r.created_at.toISOString(),
    }))
    .reverse(); // oldest → newest, to match the live append order on the client
}

export type WhisperResult =
  | { ok: true; message: WhisperMessage; fromId: number; toId: number }
  | { error: WhisperError };

/** Validate → rate-limit → persist a private message. Delivery is the caller's. */
export async function sendWhisper(
  fromId: number,
  fromUsername: string,
  toUsernameRaw: string,
  rawBody: string,
  nowMs: number,
): Promise<WhisperResult> {
  const cfg = chatConfig();
  const toUsername = toUsernameRaw.trim();
  const body = rawBody.trim();
  if (body.length === 0) return { error: 'empty_message' };
  if (body.length > cfg.max_length) return { error: 'too_long' };

  const toRes = await query('SELECT id, username FROM players WHERE username = $1', [toUsername]);
  const toRow = toRes.rows[0] as { id: string; username: string } | undefined;
  if (!toRow) return { error: 'unknown_user' };
  const toId = Number(toRow.id);
  if (toId === fromId) return { error: 'self' };

  if (!whisperRateOk(fromId, nowMs)) return { error: 'rate_limited' };

  const res = await query(
    `INSERT INTO direct_messages (from_player, to_player, body)
     VALUES ($1, $2, $3) RETURNING id, created_at`,
    [fromId, toId, body],
  );
  const row = res.rows[0] as { id: string; created_at: Date };

  return {
    ok: true as const,
    message: {
      id: Number(row.id),
      from: fromUsername,
      to: toRow.username,
      body,
      created_at: row.created_at.toISOString(),
    },
    fromId,
    toId,
  };
}
