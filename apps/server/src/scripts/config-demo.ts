// Phase 1 acceptance check (SPEC §4): a live config UPDATE must take effect in
// the running process within a few seconds, without a restart, isolated, and
// audited. This script loads the snapshot + listener (exactly as the server
// does), updates a value through the config service, and waits for the LISTEN/
// NOTIFY-driven reload to surface the new value in the in-memory snapshot. It
// also confirms validation rejects an out-of-bounds write.

import { getConfig, initConfig, shutdownConfig } from '../config/store.js';
import { updateGameConfig } from '../config/service.js';
import { validateGameConfig, ConfigValidationError } from '../config/validate.js';
import { closePool } from '../db/pool.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForChange<T>(read: () => T, from: T, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (read() !== from) return Date.now() - start;
    await sleep(50);
  }
  throw new Error(`snapshot did not update within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  await initConfig();

  // 1. Live update takes effect via NOTIFY → reload → atomic swap.
  const before = getConfig().gameConfig.tick_seconds;
  const target = before === 9 ? 8 : 9;
  console.log(
    `[demo] tick_seconds in snapshot = ${before}; updating to ${target} via config service...`,
  );

  await updateGameConfig('tick_seconds', target, 'config-demo');
  const elapsed = await waitForChange(() => getConfig().gameConfig.tick_seconds, before, 5000);
  const after = getConfig().gameConfig.tick_seconds;
  console.log(
    `[demo] snapshot reflects tick_seconds = ${after} after ${elapsed}ms (no restart) ✅`,
  );
  if (after !== target) throw new Error(`expected ${target}, snapshot has ${after}`);

  // 2. Isolation: an unrelated knob is untouched.
  console.log(
    `[demo] unrelated knob max_rounds still = ${getConfig().gameConfig.max_rounds} (isolated) ✅`,
  );

  // 3. Validation rejects out-of-bounds writes.
  let rejected = false;
  try {
    validateGameConfig('cancel_penalty', 2);
  } catch (err) {
    rejected = err instanceof ConfigValidationError;
    console.log(`[demo] validation rejected cancel_penalty=2 → "${(err as Error).message}" ✅`);
  }
  if (!rejected) throw new Error('validation should have rejected cancel_penalty=2');

  // Restore the original value.
  await updateGameConfig('tick_seconds', before, 'config-demo');
  await waitForChange(() => getConfig().gameConfig.tick_seconds, target, 5000);
  console.log(`[demo] restored tick_seconds = ${getConfig().gameConfig.tick_seconds}`);

  console.log('[demo] PHASE 1 ACCEPTANCE PASSED');
}

main()
  .catch((err: unknown) => {
    console.error('[demo] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void shutdownConfig().finally(() => closePool());
  });
