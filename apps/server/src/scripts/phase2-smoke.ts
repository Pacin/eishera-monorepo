// Phase 2 auth smoke test (hardened). Exercises cookie auth, CSRF, rate-limit
// headers, refresh rotation + reuse detection, logout revocation, and
// cookie-authenticated realtime (Socket.IO) against a running server. Uses Node
// global fetch (with a hand-rolled cookie jar) and socket.io-client (with a
// Cookie header on the handshake). Start the server first: `pnpm dev`.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { io as ioClient } from 'socket.io-client';

const PORT = Number(process.env.PORT ?? 4000);
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// ── tiny cookie jar ──────────────────────────────────────────────────────────
const jar = new Map<string, string>();
function storeSetCookies(res: Response): void {
  const setCookies = (res.headers as any).getSetCookie?.() ?? [];
  for (const c of setCookies as string[]) {
    const pair = c.split(';')[0] ?? '';
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value === '' || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}
function cookieHeader(overrides: Record<string, string> = {}): string {
  const merged = new Map(jar);
  for (const [k, v] of Object.entries(overrides)) merged.set(k, v);
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
let csrfToken = '';
async function api(
  path: string,
  opts: RequestInit & { noCookies?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (!opts.noCookies && jar.size) headers.cookie = cookieHeader();
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  storeSetCookies(res);
  return res;
}
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function wsTest(cookieStr: string | null): Promise<{ first: any; pong?: any }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: cookieStr ? { Cookie: cookieStr } : {},
    });
    const out: { first?: any; pong?: any } = {};
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('socket timeout'));
    }, 4000);
    // Unauthorized handshake → server rejects with a connect_error.
    socket.on('connect_error', (err) => {
      out.first = { type: 'error', error: err.message };
      clearTimeout(timer);
      socket.close();
      resolve({ first: out.first });
    });
    socket.on('hello', (data: any) => {
      out.first = { type: 'hello', ...data };
      socket.emit('ping', { t: 42 });
    });
    socket.on('pong', (data: any) => {
      out.pong = { type: 'pong', t: data?.t };
      clearTimeout(timer);
      socket.close();
      resolve({ first: out.first, pong: out.pong });
    });
  });
}

async function main(): Promise<void> {
  const username = `smoke_${Date.now()}`;
  const password = 'password123';

  console.log('[smoke] health + csrf');
  const health = (await api('/health').then((r) => r.json())) as any;
  check('GET /health ok', health.ok === true, health);
  const csrf = (await api('/auth/csrf').then((r) => r.json())) as any;
  csrfToken = csrf.csrfToken;
  check(
    'GET /auth/csrf returns token + sets _csrf cookie',
    typeof csrfToken === 'string' && jar.has('_csrf'),
  );

  console.log('[smoke] register (sets cookies, no token in body)');
  const reg = await api('/auth/register', json({ username, password }));
  const regBody = (await reg.json()) as any;
  check('register → 201', reg.status === 201, reg.status);
  check('access_token cookie set (httpOnly)', jar.has('access_token'));
  check('refresh_token cookie set (httpOnly)', jar.has('refresh_token'));
  check('no token in response body', regBody.token === undefined);
  check(
    'player has 6 skills',
    regBody.player?.skills?.length === 6,
    regBody.player?.skills?.length,
  );
  check(
    'player has 5 housing',
    regBody.player?.housing?.length === 5,
    regBody.player?.housing?.length,
  );
  check('full action bar', regBody.player?.actions_remaining === regBody.player?.max_actions);

  console.log('[smoke] /me (cookie auth)');
  const me = await api('/me');
  const meBody = (await me.json()) as any;
  check('GET /me → 200', me.status === 200, me.status);
  check('/me username matches', meBody.username === username);
  const meNoAuth = await api('/me', { noCookies: true });
  check('GET /me without cookie → 401', meNoAuth.status === 401, meNoAuth.status);

  console.log('[smoke] rate-limit headers on auth routes');
  const dup = await api('/auth/register', json({ username, password }));
  check('duplicate register → 409', dup.status === 409, dup.status);
  check('x-ratelimit-limit header present', dup.headers.has('x-ratelimit-limit'), [
    ...dup.headers.keys(),
  ]);

  console.log('[smoke] login good/bad + validation');
  const login = await api('/auth/login', json({ username, password }));
  check('login → 200', login.status === 200);
  const badLogin = await api('/auth/login', json({ username, password: 'wrongpassword' }));
  check('bad login → 401', badLogin.status === 401, badLogin.status);
  const badInput = await api('/auth/register', json({ username: 'ab', password: 'short' }));
  check('invalid input → 400', badInput.status === 400, badInput.status);

  console.log('[smoke] CSRF required on state-changing routes');
  const noCsrf = await api('/auth/logout', { method: 'POST' });
  check('logout without csrf-token → 403', noCsrf.status === 403, noCsrf.status);

  console.log('[smoke] refresh rotation + reuse detection');
  const oldRefresh = jar.get('refresh_token') ?? '';
  const refresh = await api('/auth/refresh', {
    method: 'POST',
    headers: { 'csrf-token': csrfToken },
  });
  check('refresh → 200', refresh.status === 200, refresh.status);
  const newRefresh = jar.get('refresh_token') ?? '';
  check('refresh token rotated', newRefresh !== '' && newRefresh !== oldRefresh);
  // Replay the OLD (now-revoked) refresh token → reuse detected.
  const reuse = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'csrf-token': csrfToken, cookie: cookieHeader({ refresh_token: oldRefresh }) },
  });
  check('replayed old refresh → 401 (reuse)', reuse.status === 401, reuse.status);
  check(
    'reuse error is token_reuse_detected',
    ((await reuse.json()) as any).error === 'token_reuse_detected',
  );

  console.log('[smoke] logout revokes session');
  // Reuse detection revoked the family; re-login for a clean logout test.
  await api('/auth/login', json({ username, password }));
  const logout = await api('/auth/logout', {
    method: 'POST',
    headers: { 'csrf-token': csrfToken },
  });
  check('logout → 200', logout.status === 200, logout.status);
  check('cookies cleared after logout', !jar.has('access_token') && !jar.has('refresh_token'));
  const meAfter = await api('/me');
  check('GET /me after logout → 401', meAfter.status === 401, meAfter.status);

  console.log('[smoke] websocket (cookie auth)');
  await api('/auth/login', json({ username, password })); // fresh session with cookies
  const wsGood = await wsTest(cookieHeader());
  check('ws hello received', wsGood.first.type === 'hello', wsGood.first);
  check('ws pong received', wsGood.pong?.type === 'pong' && wsGood.pong?.t === 42, wsGood.pong);
  const wsBad = await wsTest(null);
  check('ws without cookie rejected', wsBad.first.type === 'error', wsBad.first);

  console.log(
    failures === 0 ? '\n[smoke] PHASE 2 (HARDENED) PASSED' : `\n[smoke] FAILED (${failures})`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[smoke] error:', err);
  process.exitCode = 1;
});
