// Auth cookie helpers. The access JWT and the opaque refresh token are both
// delivered as httpOnly cookies — JavaScript can't read them, so XSS can't steal
// them (SPEC §13: no localStorage). SameSite=Strict is the primary CSRF defense;
// Secure is on in production (HTTPS). The refresh cookie is path-scoped to /auth
// so it's only ever sent to the auth endpoints.

import type { FastifyReply } from 'fastify';
import { env } from '../config/env.js';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/auth';

// Parse a TTL string like "15m" / "1h" / "7d" / "900" (bare = seconds) so the
// access cookie's max-age tracks the access JWT's expiry (env.accessTtl).
function ttlSeconds(ttl: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(ttl.trim());
  if (!m) return 15 * 60;
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return n * mult;
}

const ACCESS_MAX_AGE = ttlSeconds(env.accessTtl);
const REFRESH_MAX_AGE = env.refreshTtlDays * 24 * 60 * 60;

function baseOptions(path: string, maxAge: number) {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'strict' as const,
    path,
    maxAge,
  };
}

export function setAccessCookie(reply: FastifyReply, jwt: string): void {
  reply.setCookie(ACCESS_COOKIE, jwt, baseOptions('/', ACCESS_MAX_AGE));
}

export function setRefreshCookie(reply: FastifyReply, rawToken: string): void {
  reply.setCookie(REFRESH_COOKIE, rawToken, baseOptions(REFRESH_PATH, REFRESH_MAX_AGE));
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
}
