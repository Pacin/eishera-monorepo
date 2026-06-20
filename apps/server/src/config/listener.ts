// Dedicated LISTEN connection for live config reloads (SPEC §4.3). A pooled
// client can't hold a long-lived LISTEN, so this owns its own pg Client. On a
// 'config_changed' notification it schedules a debounced reload — a burst of
// edits collapses into a single snapshot rebuild.

import { Client } from 'pg';
import { env } from './env.js';

const DEBOUNCE_MS = 150;

let client: Client | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let reloadFn: (() => Promise<void>) | null = null;

export async function startConfigListener(onChange: () => Promise<void>): Promise<void> {
  reloadFn = onChange;
  const c = new Client({ connectionString: env.databaseUrl });
  c.on('error', (err) => console.error('[config] listener connection error:', err));
  c.on('notification', (msg) => {
    if (msg.payload) console.log(`[config] change signaled: ${msg.payload}`);
    scheduleReload();
  });
  await c.connect();
  await c.query('LISTEN config_changed');
  client = c;
  console.log('[config] listening on channel "config_changed"');
}

function scheduleReload(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void reloadFn?.().catch((err) => console.error('[config] reload failed:', err));
  }, DEBOUNCE_MS);
}

export async function stopConfigListener(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (client) {
    await client.end().catch(() => undefined);
    client = null;
  }
}
