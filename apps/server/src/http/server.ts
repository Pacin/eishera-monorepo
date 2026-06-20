// Fastify HTTP server + Socket.IO realtime (SPEC §14 Phase 2, hardened).
//
// Auth model: httpOnly cookies (no localStorage, SPEC §13). A short-lived access
// JWT (15m) authorizes requests; a long-lived opaque refresh token (rotating,
// revocable, stored hashed in Postgres) renews it. SameSite=Strict + a CSRF
// token guard cross-site abuse; auth routes are rate-limited. Socket.IO attaches
// to the same HTTP server and authenticates the access cookie at the handshake,
// reusing Fastify's cookie parser + JWT (no token in the URL).

import Fastify, { type FastifyInstance } from 'fastify';
import { Server as IOServer } from 'socket.io';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import csrf from '@fastify/csrf-protection';
import { env } from '../config/env.js';
import {
  createPlayer,
  verifyCredentials,
  getPlayerSummary,
  UsernameTakenError,
} from '../players/service.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  InvalidRefreshError,
  ReusedRefreshError,
} from '../auth/refresh.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
} from '../auth/cookies.js';
import { setRealtime, onlineCount, playerRoom } from '../ws/registry.js';
import { getConfig } from '../config/store.js';
import { selectRecipe, selectMonster, clearActivity, refreshActions } from '../actions/service.js';
import { equipInstance, unequipSlot, getEquipment } from '../equipment/service.js';
import { effectiveStatsForPlayer } from '../combat/stats.js';
import { consumePotion } from '../effects/service.js';
import type { AuthResponse, AuthTokenPayload } from '@eishera/shared';

const credentialsSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 32 },
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
} as const;

const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

interface Credentials {
  username: string;
  password: string;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cookie, { secret: env.cookieSecret });
  await app.register(jwt, {
    secret: env.jwtSecret,
    cookie: { cookieName: ACCESS_COOKIE, signed: false },
  });
  await app.register(rateLimit, { global: false });
  await app.register(csrf, {
    cookieOpts: { signed: true, sameSite: 'strict', secure: env.cookieSecure, path: '/' },
  });

  app.decorate('authenticate', async function (request, reply): Promise<void> {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Issue a fresh session: set the access + refresh cookies and persist the
  // refresh token. Used by register, login, and refresh.
  async function startSession(
    reply: Parameters<typeof setAccessCookie>[0],
    payload: AuthTokenPayload,
  ): Promise<void> {
    const accessJwt = await reply.jwtSign(payload, { expiresIn: env.accessTtl });
    setAccessCookie(reply, accessJwt);
    const rawRefresh = await issueRefreshToken(payload.playerId);
    setRefreshCookie(reply, rawRefresh);
  }

  app.get('/health', async () => ({ ok: true }));

  // Hand out a CSRF token (and set the secret cookie). The SPA calls this once,
  // keeps the token in memory, and sends it as the `csrf-token` header on
  // state-changing requests.
  app.get('/auth/csrf', async (_request, reply) => {
    return { csrfToken: reply.generateCsrf() };
  });

  app.post(
    '/auth/register',
    { schema: credentialsSchema, ...authRateLimit },
    async (request, reply) => {
      const { username, password } = request.body as Credentials;
      try {
        const playerId = await createPlayer(username, password);
        await startSession(reply, { playerId, username });
        const player = await getPlayerSummary(playerId);
        if (!player) throw new Error('player missing immediately after creation');
        const body: AuthResponse = { player };
        return reply.code(201).send(body);
      } catch (err) {
        if (err instanceof UsernameTakenError) {
          return reply.code(409).send({ error: 'username_taken' });
        }
        throw err;
      }
    },
  );

  app.post(
    '/auth/login',
    { schema: credentialsSchema, ...authRateLimit },
    async (request, reply) => {
      const { username, password } = request.body as Credentials;
      const playerId = await verifyCredentials(username, password);
      if (playerId === null) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      await startSession(reply, { playerId, username });
      const player = await getPlayerSummary(playerId);
      if (!player) return reply.code(404).send({ error: 'not_found' });
      const body: AuthResponse = { player };
      return reply.send(body);
    },
  );

  // Rotate the refresh token and reissue the access cookie. CSRF-guarded.
  app.post(
    '/auth/refresh',
    { onRequest: app.csrfProtection, ...authRateLimit },
    async (request, reply) => {
      const raw = request.cookies[REFRESH_COOKIE];
      if (!raw) {
        clearAuthCookies(reply);
        return reply.code(401).send({ error: 'no_refresh_token' });
      }
      try {
        const { playerId, rawNew } = await rotateRefreshToken(raw);
        const summary = await getPlayerSummary(playerId);
        const username = summary?.username ?? '';
        const accessJwt = await reply.jwtSign({ playerId, username }, { expiresIn: env.accessTtl });
        setAccessCookie(reply, accessJwt);
        setRefreshCookie(reply, rawNew);
        return reply.send({ ok: true });
      } catch (err) {
        clearAuthCookies(reply);
        if (err instanceof ReusedRefreshError) {
          return reply.code(401).send({ error: 'token_reuse_detected' });
        }
        if (err instanceof InvalidRefreshError) {
          return reply.code(401).send({ error: 'invalid_refresh_token' });
        }
        throw err;
      }
    },
  );

  // Revoke the current refresh token and clear cookies. CSRF-guarded.
  app.post('/auth/logout', { onRequest: app.csrfProtection }, async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE];
    if (raw) await revokeRefreshToken(raw);
    clearAuthCookies(reply);
    return reply.send({ ok: true });
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (request, reply) => {
    const player = await getPlayerSummary(request.user.playerId);
    if (!player) return reply.code(404).send({ error: 'not_found' });
    return player;
  });

  // Select the current transform activity (a recipe). CSRF + auth.
  app.post(
    '/actions/select',
    {
      onRequest: app.csrfProtection,
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['recipeId'],
          additionalProperties: false,
          properties: { recipeId: { type: ['integer', 'null'] } },
        },
      },
    },
    async (request, reply) => {
      const { recipeId } = request.body as { recipeId: number | null };
      if (recipeId === null) {
        await clearActivity(request.user.playerId);
      } else if (getConfig().recipes.has(recipeId)) {
        await selectRecipe(request.user.playerId, recipeId);
      } else {
        return reply.code(400).send({ error: 'unknown_recipe' });
      }
      return getPlayerSummary(request.user.playerId);
    },
  );

  // Refill the action bar to max_actions. CSRF + auth.
  app.post(
    '/actions/refresh',
    { onRequest: app.csrfProtection, preHandler: [app.authenticate] },
    async (request) => {
      await refreshActions(request.user.playerId);
      return getPlayerSummary(request.user.playerId);
    },
  );

  // Select a monster to battle (combat). CSRF + auth.
  app.post(
    '/actions/battle',
    {
      onRequest: app.csrfProtection,
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['monsterId'],
          additionalProperties: false,
          properties: { monsterId: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const { monsterId } = request.body as { monsterId: number };
      if (!getConfig().monsters.has(monsterId)) {
        return reply.code(400).send({ error: 'unknown_monster' });
      }
      await selectMonster(request.user.playerId, monsterId);
      return getPlayerSummary(request.user.playerId);
    },
  );

  // Consume a potion → active effect. CSRF + auth.
  app.post(
    '/actions/consume',
    {
      onRequest: app.csrfProtection,
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['itemCode'],
          additionalProperties: false,
          properties: { itemCode: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { itemCode } = request.body as { itemCode: string };
      const result = await consumePotion(request.user.playerId, itemCode, getConfig());
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  // Equipment: equip / unequip / view. CSRF + auth on the mutating routes.
  app.post(
    '/equipment/equip',
    {
      onRequest: app.csrfProtection,
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['instanceId'],
          additionalProperties: false,
          properties: { instanceId: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const { instanceId } = request.body as { instanceId: number };
      const result = await equipInstance(request.user.playerId, instanceId, getConfig());
      if ('error' in result) return reply.code(400).send(result);
      return getEquipment(request.user.playerId, getConfig());
    },
  );

  app.post(
    '/equipment/unequip',
    {
      onRequest: app.csrfProtection,
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['slot'],
          additionalProperties: false,
          properties: { slot: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const { slot } = request.body as { slot: string };
      await unequipSlot(request.user.playerId, slot);
      return getEquipment(request.user.playerId, getConfig());
    },
  );

  app.get('/equipment', { preHandler: [app.authenticate] }, async (request) => {
    const cfg = getConfig();
    const [equipped, stats] = await Promise.all([
      getEquipment(request.user.playerId, cfg),
      effectiveStatsForPlayer(request.user.playerId, cfg),
    ]);
    return { equipped, stats };
  });

  // ── Socket.IO realtime ──────────────────────────────────────────────────────
  // Attached to Fastify's underlying HTTP server (same port). Same-origin in
  // prod and via the Vite dev proxy; SameSite=Strict on the access cookie blocks
  // cross-site handshakes from carrying it, so a permissive dev CORS origin is safe.
  const io = new IOServer(app.server, {
    cors: { origin: true, credentials: true },
  });

  // Handshake auth: verify the access cookie, reusing the same cookie parser +
  // JWT the HTTP routes use (not a separate verification path).
  io.use((socket, next) => {
    try {
      const cookies = app.parseCookie(socket.handshake.headers.cookie ?? '');
      const payload = app.jwt.verify(cookies[ACCESS_COOKIE] ?? '') as { playerId: number };
      (socket.data as { playerId: number }).playerId = payload.playerId;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const playerId = (socket.data as { playerId: number }).playerId;
    void socket.join(playerRoom(playerId));
    socket.emit('hello', { playerId, online: onlineCount() });
    socket.on('ping', (data: { t?: number } | undefined) => {
      socket.emit('pong', { t: data?.t ?? null });
    });
  });

  setRealtime(io);
  return app;
}
