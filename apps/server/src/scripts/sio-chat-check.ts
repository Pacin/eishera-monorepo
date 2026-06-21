// Chat over Socket.IO (SPEC §11). Connects two players' sockets, has one send a
// `chat:send` event, and asserts the other receives the `chat:message` broadcast;
// then connects a fresh socket and asserts it gets the channel's recent history
// on connect (from the ring buffer); finally floods past the rate limit and
// asserts a `chat:error` (rate_limited) is relayed to the sender. Start the
// server first (pnpm --filter @eishera/server build && start, or tsx src/index.ts).
import { io as ioClient, type Socket } from 'socket.io-client';
import { closePool } from '../db/pool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PORT = Number(process.env.PORT ?? 4000);
const BASE = `http://localhost:${PORT}`;
const CHANNEL = 'global';

let failures = 0;
const check = (label: string, cond: boolean, detail?: unknown): void => {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
};

function makeClient() {
  const jar = new Map<string, string>();
  let csrf = '';
  const store = (res: Response): void => {
    for (const c of ((res.headers as any).getSetCookie?.() ?? []) as string[]) {
      const pair = c.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /max-age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
  };
  const cookie = (): string => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const api = async (path: string, opts: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (jar.size) headers.cookie = cookie();
    if (csrf) headers['csrf-token'] = csrf;
    const res = await fetch(`${BASE}${path}`, { ...opts, headers });
    store(res);
    return res;
  };
  const register = async (username: string): Promise<number> => {
    csrf = ((await api('/auth/csrf').then((r) => r.json())) as any).csrfToken;
    const reg = (await api('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123' }),
    }).then((r) => r.json())) as any;
    return reg.player.id;
  };
  return { cookie, register };
}

const connect = (cookie: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(BASE, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 8000);
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${e.message}`));
    });
    socket.on('hello', () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });

const once = <T = any>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} within timeout`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

async function main(): Promise<void> {
  const ts = Date.now();
  const a = makeClient();
  const b = makeClient();
  const nameA = `c9a_${ts}`;
  await a.register(nameA);
  await b.register(`c9b_${ts}`);

  const sockA = await connect(a.cookie());
  const sockB = await connect(b.cookie());

  // ── 1. Broadcast: A sends, B receives ───────────────────────────────────────
  const marker = `hi-${ts}`;
  const recvB = once(sockB, 'chat:message');
  sockA.emit('chat:send', { channel: CHANNEL, body: marker });
  const msg = await recvB;
  check(
    'B received A’s chat:message broadcast',
    msg?.body === marker && msg?.channel === CHANNEL && msg?.username === nameA,
    msg,
  );

  // ── 2. History on connect: a fresh socket gets recent history ───────────────
  const c = makeClient();
  await c.register(`c9c_${ts}`);
  const sockC = ioClient(BASE, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Cookie: c.cookie() },
  });
  const history = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no chat:history within timeout')), 8000);
    sockC.on('chat:history', (payload: any) => {
      if (payload.channel === CHANNEL) {
        clearTimeout(timer);
        resolve(payload);
      }
    });
    sockC.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${e.message}`));
    });
  });
  check(
    'new socket gets channel history including the prior message',
    Array.isArray(history.messages) && history.messages.some((m: any) => m.body === marker),
    history.messages?.slice(-2),
  );

  // ── 3. Rate limit relays a definitive error to the sender ───────────────────
  const errP = once(sockA, 'chat:error');
  for (let i = 0; i < 10; i++) sockA.emit('chat:send', { channel: CHANNEL, body: `spam-${i}` });
  const err = await errP;
  check('sender gets chat:error rate_limited when flooding', err?.error === 'rate_limited', err);

  sockA.close();
  sockB.close();
  sockC.close();
  console.log(failures === 0 ? '\n[sio-chat] PASSED' : `\n[sio-chat] FAILED (${failures})`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error('[sio-chat] error:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
