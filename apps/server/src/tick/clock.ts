// Live clock (SPEC §5). uptime_seconds advances only while the server is up and
// must FREEZE across downtime — it is driven by these counters, never by
// wall-clock fast-forwarding. Pure and side-effect-free so it can be reasoned
// about and tested directly.

export interface LiveClockStep {
  /** Seconds to add to uptime_seconds this tick. */
  uptimeDelta: number;
  /** True when the gap since the last tick exceeded the outage threshold. */
  outage: boolean;
}

/**
 * Decide how much the live clock advances this tick.
 * - First tick ever (no prior tick time): add 0.
 * - Normal operation (delta within threshold): add the real elapsed seconds.
 * - Outage (delta beyond threshold): add only one normal interval; freeze the rest.
 */
export function liveClockStep(
  deltaSeconds: number | null,
  tickSeconds: number,
  outageThreshold: number,
): LiveClockStep {
  if (deltaSeconds === null) return { uptimeDelta: 0, outage: false };
  if (deltaSeconds <= outageThreshold) {
    return { uptimeDelta: Math.max(0, Math.round(deltaSeconds)), outage: false };
  }
  return { uptimeDelta: tickSeconds, outage: true };
}
