// Chat service (SPEC §11). One entry point: send a message. It validates the
// channel/body, enforces a per-player rate limit, persists the message durably
// to `chat_messages` (the moderation record), then appends it to the in-memory
// ring buffer and returns it. Broadcasting over Socket.IO is the caller's job
// (the socket handler), so this service is usable without a live socket — which
// keeps it testable and decoupled.

import { query } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import { chatBuffer } from './buffer.js';
import type { ChatMessage } from '@eishera/shared';

interface ChatConfig {
  channels: string[];
  buffer_size: number;
  rate_max: number;
  rate_window_seconds: number;
  max_length: number;
}

const chatConfig = (): ChatConfig => getConfig().raw.get('chat') as ChatConfig;

export type ChatError = 'unknown_channel' | 'empty_message' | 'too_long' | 'rate_limited';

// Per-player sliding window of recent send timestamps (ms). This is ephemeral
// anti-spam infra (not game state), so wall-clock is correct here — it is not a
// freeze-on-downtime timer. Memory-only; losing it just resets the window.
const recentSends = new Map<number, number[]>();

/** True if the player is within the rate limit (and records the send if so). */
function rateLimitOk(playerId: number, nowMs: number): boolean {
  const { rate_max, rate_window_seconds } = chatConfig();
  const windowStart = nowMs - rate_window_seconds * 1000;
  const stamps = (recentSends.get(playerId) ?? []).filter((t) => t > windowStart);
  if (stamps.length >= rate_max) {
    recentSends.set(playerId, stamps); // keep the pruned window
    return false;
  }
  stamps.push(nowMs);
  recentSends.set(playerId, stamps);
  return true;
}

export function recentHistory(channel: string): ChatMessage[] {
  return chatBuffer.recent(channel);
}

export function allowedChannels(): string[] {
  return chatConfig().channels;
}

/**
 * Validate → rate-limit → persist → buffer. Returns the stored message (which
 * the caller broadcasts) or a definitive error (the caller relays to the sender).
 */
export async function sendMessage(
  playerId: number,
  username: string,
  channel: string,
  rawBody: string,
  nowMs: number,
): Promise<ChatMessage | { error: ChatError }> {
  const cfg = chatConfig();
  if (!cfg.channels.includes(channel)) return { error: 'unknown_channel' };
  const body = rawBody.trim();
  if (body.length === 0) return { error: 'empty_message' };
  if (body.length > cfg.max_length) return { error: 'too_long' };
  if (!rateLimitOk(playerId, nowMs)) return { error: 'rate_limited' };

  // Persist durably first (the moderation record is the source of truth).
  const res = await query(
    `INSERT INTO chat_messages (channel, player_id, body)
     VALUES ($1, $2, $3) RETURNING id, created_at`,
    [channel, playerId, body],
  );
  const row = res.rows[0] as { id: string; created_at: Date };

  const message: ChatMessage = {
    id: Number(row.id),
    channel,
    player_id: playerId,
    username,
    body,
    created_at: row.created_at.toISOString(),
  };
  chatBuffer.push(message);
  return message;
}
