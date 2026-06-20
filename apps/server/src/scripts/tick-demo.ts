// Phase 3 acceptance check (SPEC §5, §6, §14). Drives runTick() directly (no
// heartbeat) to prove, deterministically:
//   1. each tick is atomic and advances tick_number by exactly 1;
//   2. the live clock advances by real elapsed time during normal operation;
//   3. DOWNTIME FREEZES — a large gap adds only one normal interval, not the gap;
//   4. the resume point is the last committed world_state (crash-resilience).
// (The real process kill/restart is exercised separately in the verify script.)

import { initConfig, getConfig, shutdownConfig } from '../config/store.js';
import { ensureWorldState, readWorldState, runTick } from '../tick/loop.js';
import { query, closePool } from '../db/pool.js';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function setLastTickAgo(seconds: number): Promise<void> {
  await query(
    `UPDATE world_state SET last_tick_at = now() - ($1 || ' seconds')::interval WHERE id = TRUE`,
    [String(seconds)],
  );
}

async function main(): Promise<void> {
  await initConfig();
  await ensureWorldState();
  const { tick_seconds, outage_threshold_seconds } = getConfig().gameConfig;
  console.log(`[demo] tick_seconds=${tick_seconds}, outage_threshold=${outage_threshold_seconds}s`);

  console.log('[demo] normal tick (simulated ~tick_seconds elapsed)');
  await setLastTickAgo(tick_seconds);
  const before1 = await readWorldState();
  const r1 = await runTick();
  check('tick_number += 1', r1.tickNumber === before1.tick_number + 1, {
    before: before1.tick_number,
    after: r1.tickNumber,
  });
  const d1 = r1.uptimeSeconds - before1.uptime_seconds;
  check(
    'normal: uptime advances ~real elapsed',
    d1 >= tick_seconds - 1 && d1 <= tick_seconds + 1,
    d1,
  );
  check('normal: not flagged as outage', r1.outage === false);

  console.log('[demo] DOWNTIME: simulate a long gap (10x the threshold)');
  const gap = outage_threshold_seconds * 10;
  await setLastTickAgo(gap);
  const before2 = await readWorldState();
  const r2 = await runTick();
  const d2 = r2.uptimeSeconds - before2.uptime_seconds;
  check('outage detected', r2.outage === true);
  check(`freeze: uptime += tick_seconds only (not ${gap}s)`, d2 === tick_seconds, {
    added: d2,
    gap,
  });
  check('tick still advances by 1 during outage', r2.tickNumber === before2.tick_number + 1);

  console.log('[demo] resume point = last committed world_state');
  const persisted = await readWorldState();
  check(
    'persisted tick_number == last tick (resume here on restart)',
    persisted.tick_number === r2.tickNumber,
  );
  check('persisted uptime == last tick uptime', persisted.uptime_seconds === r2.uptimeSeconds);

  console.log(
    failures === 0 ? '\n[demo] PHASE 3 ACCEPTANCE PASSED' : `\n[demo] FAILED (${failures})`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error('[demo] error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void shutdownConfig().finally(() => closePool());
  });
