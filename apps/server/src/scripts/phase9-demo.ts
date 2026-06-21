// Phase 9 acceptance check (SPEC §11). Proves, at the service layer (no socket):
//   1. every message persists to chat_messages (the moderation record);
//   2. the in-memory ring buffer serves recent history, capped at buffer_size,
//      and is rebuildable from Postgres after cache loss;
//   3. the per-player rate limit is enforced (definitive error, not a silent drop);
//   4. validation rejects unknown channels, empty, and over-length bodies.
// The socket broadcast + history-on-connect path is covered by sio-chat-check.

import { initConfig, getConfig, shutdownConfig } from '../config/store.js';
import { createPlayer } from '../players/service.js';
import { sendMessage, recentHistory } from '../chat/service.js';
import { chatBuffer } from '../chat/buffer.js';
import { query, closePool } from '../db/pool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main(): Promise<void> {
  await initConfig();
  const cfg = getConfig();
  const chat = cfg.raw.get('chat') as {
    channels: string[];
    buffer_size: number;
    rate_max: number;
    max_length: number;
  };
  const ts = Date.now();
  const channel = chat.channels[0]!; // 'global'

  // Warm the buffer from existing rows so this run starts from a known state.
  await chatBuffer.rebuild();

  const name = `p9_${ts}`;
  const playerId = await createPlayer(name, 'password123');

  // ── 1. Persist + broadcast-ready: a send writes a row and returns the message ─
  console.log('[demo] message persists to chat_messages + enters the ring buffer');
  const marker = `hello-${ts}`;
  const sent = await sendMessage(playerId, name, channel, marker, ts);
  check('send returned a stored message', !('error' in sent), sent);
  const dbRow = (
    await query(
      'SELECT id, channel, player_id, body FROM chat_messages WHERE player_id=$1 AND body=$2',
      [playerId, marker],
    )
  ).rows[0] as any;
  check('message persisted to chat_messages', dbRow?.body === marker, dbRow);
  check(
    'persisted row matches returned message id',
    !('error' in sent) && Number(dbRow.id) === sent.id,
    { dbRow, sent },
  );

  // ── 2. Ring buffer serves recent history ───────────────────────────────────
  console.log('[demo] ring buffer serves recent history');
  const recent = recentHistory(channel);
  check(
    'buffer contains the just-sent message',
    recent.some((m) => m.body === marker && m.username === name),
    recent.slice(-3),
  );

  // ── 2b. Buffer is capped at buffer_size and rebuildable from Postgres ───────
  console.log('[demo] buffer is capped at buffer_size and rebuildable from Postgres');
  const overflow = chat.buffer_size + 5;
  for (let i = 0; i < overflow; i++) {
    // Use a wide-open time window so the rate limit never trips here.
    await sendMessage(playerId, name, channel, `flood-${ts}-${i}`, ts + 1000 + i * 60_000);
  }
  const capped = recentHistory(channel);
  check('buffer never exceeds buffer_size', capped.length === chat.buffer_size, {
    length: capped.length,
    cap: chat.buffer_size,
  });
  check(
    'buffer keeps the newest messages (oldest evicted)',
    capped[capped.length - 1]!.body === `flood-${ts}-${overflow - 1}`,
    capped[capped.length - 1],
  );
  // Simulate cache loss → rebuild from Postgres yields the same newest tail.
  await chatBuffer.rebuild();
  const rebuilt = chatBuffer.recent(channel);
  check(
    'rebuild from Postgres restores the same newest message',
    rebuilt[rebuilt.length - 1]!.body === `flood-${ts}-${overflow - 1}`,
    rebuilt[rebuilt.length - 1],
  );
  check('rebuild respects buffer_size cap', rebuilt.length === chat.buffer_size, rebuilt.length);

  // ── 3. Rate limit enforced ──────────────────────────────────────────────────
  console.log('[demo] per-player rate limit enforced');
  const rl = `rl_${ts}`;
  const limiter = await createPlayer(rl, 'password123');
  const now = ts + 10_000_000; // fresh window, far from earlier sends
  const results = [];
  for (let i = 0; i < chat.rate_max + 2; i++) {
    results.push(await sendMessage(limiter, rl, channel, `spam-${i}`, now + i)); // within 1 window
  }
  const accepted = results.filter((r) => !('error' in r)).length;
  const limited = results.filter((r) => 'error' in r && r.error === 'rate_limited').length;
  check('exactly rate_max messages accepted', accepted === chat.rate_max, accepted);
  check('excess messages get a definitive rate_limited error', limited === 2, limited);

  // ── 4. Validation ───────────────────────────────────────────────────────────
  console.log('[demo] validation: unknown channel, empty, over-length');
  const badChan = await sendMessage(playerId, name, 'nonexistent', 'hi', ts + 99_000_000);
  check(
    'unknown channel rejected',
    'error' in badChan && badChan.error === 'unknown_channel',
    badChan,
  );
  const empty = await sendMessage(playerId, name, channel, '   ', ts + 99_000_001);
  check(
    'empty (whitespace) message rejected',
    'error' in empty && empty.error === 'empty_message',
    empty,
  );
  const tooLong = await sendMessage(
    playerId,
    name,
    channel,
    'x'.repeat(chat.max_length + 1),
    ts + 99_000_002,
  );
  check(
    'over-length message rejected',
    'error' in tooLong && tooLong.error === 'too_long',
    tooLong,
  );

  console.log(
    failures === 0 ? '\n[demo] PHASE 9 ACCEPTANCE PASSED' : `\n[demo] FAILED (${failures})`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error('[phase9-demo] error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void shutdownConfig().then(() => closePool());
  });
