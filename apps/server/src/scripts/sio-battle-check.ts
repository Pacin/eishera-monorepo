// Realtime battle-push check (Socket.IO). Registers a player, connects a
// socket.io-client with the auth cookie, starts a battle, and asserts the tick
// pushes a `battle` event to the connected client. Run against a server whose
// tick is fast (set tick_seconds low). Start the server first.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { io as ioClient } from 'socket.io-client';

const PORT = Number(process.env.PORT ?? 4000);
const BASE = `http://localhost:${PORT}`;

const jar = new Map<string, string>();
function store(res: Response): void {
  for (const c of ((res.headers as any).getSetCookie?.() ?? []) as string[]) {
    const pair = c.split(';')[0] ?? '';
    const i = pair.indexOf('=');
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === '' || /max-age=0/i.test(c)) jar.delete(k);
    else jar.set(k, v);
  }
}
const cookieHeader = (): string => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (jar.size) headers.cookie = cookieHeader();
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  store(res);
  return res;
}

async function main(): Promise<void> {
  const csrf = (await api('/auth/csrf').then((r) => r.json())) as any;
  await api('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `sio_${Date.now()}`, password: 'password123' }),
  });

  const battle = await new Promise<any>((resolve, reject) => {
    const socket = ioClient(BASE, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Cookie: cookieHeader() },
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('no battle event within timeout'));
    }, 12000);
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${e.message}`));
    });
    socket.on('hello', async () => {
      // Start a battle; the next tick will push a `battle` result (win or loss).
      await api('/actions/battle', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'csrf-token': csrf.csrfToken },
        body: JSON.stringify({ monsterId: 1 }),
      });
      await api('/actions/refresh', { method: 'POST', headers: { 'csrf-token': csrf.csrfToken } });
    });
    socket.on('battle', (result: any) => {
      clearTimeout(timer);
      socket.close();
      resolve(result);
    });
  });

  const ok =
    typeof battle?.monster === 'string' &&
    typeof battle?.rounds === 'number' &&
    typeof battle?.damage_dealt === 'number' &&
    typeof battle?.won === 'boolean';
  console.log(`  ${ok ? '✅' : '❌'} received battle event:`, JSON.stringify(battle));
  console.log(ok ? '\n[sio] BATTLE PUSH OK' : '\n[sio] FAILED');
  if (!ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[sio] error:', err);
  process.exitCode = 1;
});
