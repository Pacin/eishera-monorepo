// Tiny display helpers shared across panels.

export const fmt = (n: number): string => Math.floor(n).toLocaleString('en-US');

/** Seconds → "1h 02m 03s" / "02m 03s" / "03s". */
export function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}
