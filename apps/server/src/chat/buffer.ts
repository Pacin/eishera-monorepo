// Per-channel "last N" ring buffer (SPEC §11). This is a CACHE only — every
// message is durably persisted to `chat_messages` (the service does that); the
// buffer just serves recent history fast and is fully rebuildable from Postgres.
//
// It sits behind the ChatBuffer interface so a later multi-process move can
// swap this single-process implementation for a Redis-backed one without
// touching the chat service or socket handlers (SPEC §2.1: real-time modules
// behind an interface).

import { query } from '../db/pool.js';
import { getConfig } from '../config/store.js';
import type { ChatMessage } from '@eishera/shared';

export interface ChatBuffer {
  /** Append a message to a channel, trimming to the configured size. */
  push(message: ChatMessage): void;
  /** Recent messages for a channel, oldest → newest (cap = config buffer_size). */
  recent(channel: string): ChatMessage[];
  /** Rebuild every configured channel's buffer from Postgres (startup/cache loss). */
  rebuild(): Promise<void>;
}

interface ChatConfig {
  channels: string[];
  buffer_size: number;
}

const chatConfig = (): ChatConfig => getConfig().raw.get('chat') as ChatConfig;

class InMemoryChatBuffer implements ChatBuffer {
  // channel → messages, oldest first.
  private readonly channels = new Map<string, ChatMessage[]>();

  push(message: ChatMessage): void {
    const cap = chatConfig().buffer_size;
    let list = this.channels.get(message.channel);
    if (!list) {
      list = [];
      this.channels.set(message.channel, list);
    }
    list.push(message);
    // Trim from the front to the live cap (cap can change via live config).
    if (list.length > cap) list.splice(0, list.length - cap);
  }

  recent(channel: string): ChatMessage[] {
    return [...(this.channels.get(channel) ?? [])];
  }

  async rebuild(): Promise<void> {
    const { channels, buffer_size } = chatConfig();
    this.channels.clear();
    for (const channel of channels) {
      // Newest N from Postgres, then reverse to oldest → newest for the buffer.
      const res = await query(
        `SELECT m.id, m.channel, m.player_id, p.username, m.body, m.created_at
           FROM chat_messages m
           JOIN players p ON p.id = m.player_id
          WHERE m.channel = $1
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2`,
        [channel, buffer_size],
      );
      const list: ChatMessage[] = res.rows
        .map((r) => ({
          id: Number((r as { id: string }).id),
          channel: (r as { channel: string }).channel,
          player_id: Number((r as { player_id: string }).player_id),
          username: (r as { username: string }).username,
          body: (r as { body: string }).body,
          created_at: (r as { created_at: Date }).created_at.toISOString(),
        }))
        .reverse();
      this.channels.set(channel, list);
    }
  }
}

/** Process-wide chat buffer singleton (memory cache, rebuildable from Postgres). */
export const chatBuffer: ChatBuffer = new InMemoryChatBuffer();
