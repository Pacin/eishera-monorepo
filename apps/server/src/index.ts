// Phase 3 entrypoint. Verifies Postgres, loads the live config snapshot, starts
// the Fastify HTTP + websocket server, then starts the single heartbeat (tick
// loop). Graceful shutdown stops the heartbeat first so no tick is in flight
// when the pool closes.

import { healthcheck, closePool } from './db/pool.js';
import { env } from './config/env.js';
import { initConfig, getConfig, shutdownConfig } from './config/store.js';
import { buildServer } from './http/server.js';
import { ensureWorldState, readWorldState, startTickLoop, stopTickLoop } from './tick/loop.js';
import { closeRealtime } from './ws/registry.js';

async function main(): Promise<void> {
  console.log(`[eishera] server starting (port: ${env.port})`);
  const ok = await healthcheck();
  console.log(`[eishera] postgres reachable: ${ok}`);
  if (!ok) throw new Error('Postgres healthcheck failed');

  await initConfig();
  const cfg = getConfig();
  console.log(
    `[eishera] config loaded — skills=${cfg.skills.size}, housing=${cfg.housingFeatures.size}`,
  );
  if (env.jwtSecretIsDevDefault) {
    console.warn('[eishera] WARNING: JWT_SECRET not set — using insecure dev default.');
  }

  const app = await buildServer();
  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(`[eishera] http + socket.io listening on :${env.port}`);

  // Resume the world from the last committed tick (crash-resilient) and start
  // the heartbeat. The first tick's live clock freezes any downtime gap (§5).
  await ensureWorldState();
  const resume = await readWorldState();
  console.log(
    `[eishera] resuming world at tick #${resume.tick_number}, uptime=${resume.uptime_seconds}s`,
  );
  startTickLoop();
  console.log(
    `[eishera] ready — Phase 8 (world boss + boosts). Heartbeat every ${cfg.gameConfig.tick_seconds}s.`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[eishera] received ${signal}, shutting down...`);
    stopTickLoop();
    await closeRealtime().catch(() => undefined); // closes Socket.IO + the HTTP server
    await app.close().catch(() => undefined);
    await shutdownConfig().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[eishera] fatal:', err);
  process.exitCode = 1;
  void closePool();
});
