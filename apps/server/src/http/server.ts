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
import {
  setRealtime,
  onlineCount,
  playerRoom,
  chatRoom,
  broadcastToChannel,
} from '../ws/registry.js';
import { sendMessage, recentHistory, allowedChannels } from '../chat/service.js';
import { getConfig } from '../config/store.js';
import { buildCatalog } from '../config/catalog.js';
import { selectRecipe, selectMonster, clearActivity, refreshActions } from '../actions/service.js';
import { equipInstance, unequipSlot, getEquipment } from '../equipment/service.js';
import { effectiveStatsForPlayer } from '../combat/stats.js';
import { consumePotion } from '../effects/service.js';
import { startUpgrade, cancelUpgrade, getHousing } from '../housing/service.js';
import { placeOrder, cancelOrder, getBook } from '../market/orders.js';
import { listInstance, buyListing, cancelListing, getListings } from '../market/listings.js';
import { salvageInstance } from '../market/salvage.js';
import { joinBoss, getBoss } from '../boss/service.js';
import { buyBoost } from '../effects/boosts.js';
import type { AuthResponse, AuthTokenPayload, MarketSide } from '@eishera/shared';

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

  // Read-only content catalog + client formula constants (SPEC §13). Auth-gated
  // for consistency; carries no per-player or authoritative state.
  app.get('/config', { preHandler: [app.authenticate] }, async () => buildCatalog());

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

  // Housing: start / cancel an upgrade, view state. CSRF + auth on mutations.
  app.post(
    '/housing/upgrade',
    {
      onRequest: app.csrfProtection,
      preHandler: [app.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['featureId'],
          additionalProperties: false,
          properties: { featureId: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const { featureId } = request.body as { featureId: number };
      const result = await startUpgrade(request.user.playerId, featureId, getConfig());
      if ('error' in result) {
        const code = result.error === 'unknown_feature' ? 404 : 400;
        return reply.code(code).send(result);
      }
      return getHousing(request.user.playerId, getConfig());
    },
  );

  app.post(
    '/housing/cancel',
    { onRequest: app.csrfProtection, preHandler: [app.authenticate] },
    async (request, reply) => {
      const result = await cancelUpgrade(request.user.playerId, getConfig());
      if ('error' in result) return reply.code(400).send(result);
      // Include the fresh housing view so the client can update without a GET.
      const view = await getHousing(request.user.playerId, getConfig());
      return { ...result, view };
    },
  );

  app.get('/housing', { preHandler: [app.authenticate] }, async (request) => {
    return getHousing(request.user.playerId, getConfig());
  });

  // ── Market: fungible order book ─────────────────────────────────────────────
  const mutate = { onRequest: app.csrfProtection, preHandler: [app.authenticate] };

  app.post(
    '/market/orders',
    {
      ...mutate,
      schema: {
        body: {
          type: 'object',
          required: ['side', 'item_id', 'price', 'qty', 'idem_key'],
          additionalProperties: false,
          properties: {
            side: { type: 'string', enum: ['buy', 'sell'] },
            item_id: { type: 'integer' },
            price: { type: 'integer', minimum: 1 },
            qty: { type: 'integer', minimum: 1 },
            idem_key: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as {
        side: MarketSide;
        item_id: number;
        price: number;
        qty: number;
        idem_key: string;
      };
      const result = await placeOrder(
        request.user.playerId,
        b.side,
        b.item_id,
        b.price,
        b.qty,
        b.idem_key,
      );
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  app.post(
    '/market/orders/cancel',
    {
      ...mutate,
      schema: {
        body: {
          type: 'object',
          required: ['order_id'],
          additionalProperties: false,
          properties: { order_id: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const { order_id } = request.body as { order_id: number };
      const result = await cancelOrder(request.user.playerId, order_id);
      if ('error' in result)
        return reply.code(result.error === 'not_found' ? 404 : 400).send(result);
      return result;
    },
  );

  app.get(
    '/market/book',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: {
          type: 'object',
          required: ['item_id'],
          properties: { item_id: { type: 'integer' } },
        },
      },
    },
    async (request) => getBook((request.query as { item_id: number }).item_id),
  );

  // ── Market: instance listings ───────────────────────────────────────────────
  app.post(
    '/market/listings',
    {
      ...mutate,
      schema: {
        body: {
          type: 'object',
          required: ['instance_id', 'price', 'idem_key'],
          additionalProperties: false,
          properties: {
            instance_id: { type: 'integer' },
            price: { type: 'integer', minimum: 1 },
            idem_key: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as { instance_id: number; price: number; idem_key: string };
      const result = await listInstance(request.user.playerId, b.instance_id, b.price, b.idem_key);
      if ('error' in result) return reply.code(400).send(result);
      return result;
    },
  );

  app.post(
    '/market/listings/buy',
    {
      ...mutate,
      schema: {
        body: {
          type: 'object',
          required: ['listing_id'],
          additionalProperties: false,
          properties: { listing_id: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const { listing_id } = request.body as { listing_id: number };
      const result = await buyListing(request.user.playerId, listing_id);
      if ('error' in result) {
        const code =
          result.error === 'not_found' ? 404 : result.error === 'no_longer_available' ? 409 : 400;
        return reply.code(code).send(result);
      }
      return result;
    },
  );

  app.post(
    '/market/listings/cancel',
    {
      ...mutate,
      schema: {
        body: {
          type: 'object',
          required: ['listing_id'],
          additionalProperties: false,
          properties: { listing_id: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const { listing_id } = request.body as { listing_id: number };
      const result = await cancelListing(request.user.playerId, listing_id);
      if ('error' in result)
        return reply.code(result.error === 'not_found' ? 404 : 400).send(result);
      return result;
    },
  );

  app.get(
    '/market/listings',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: {
          type: 'object',
          required: ['item_id'],
          properties: { item_id: { type: 'integer' } },
        },
      },
    },
    async (request) => getListings((request.query as { item_id: number }).item_id, getConfig()),
  );

  // ── Salvage (instance sink) ─────────────────────────────────────────────────
  app.post(
    '/salvage',
    {
      ...mutate,
      schema: {
        body: {
          type: 'object',
          required: ['instance_id'],
          additionalProperties: false,
          properties: { instance_id: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const { instance_id } = request.body as { instance_id: number };
      const result = await salvageInstance(request.user.playerId, instance_id, getConfig());
      if ('error' in result) {
        return reply.code(result.error === 'unknown_instance' ? 404 : 400).send(result);
      }
      return result;
    },
  );

  // ── World boss + global boosts ──────────────────────────────────────────────
  app.post('/boss/join', mutate, async (request) => joinBoss(request.user.playerId, getConfig()));

  app.get('/boss', { preHandler: [app.authenticate] }, async (request) =>
    getBoss(request.user.playerId),
  );

  app.post(
    '/boosts/buy',
    {
      ...mutate,
      schema: {
        body: {
          type: 'object',
          required: ['boostCode'],
          additionalProperties: false,
          properties: { boostCode: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { boostCode } = request.body as { boostCode: string };
      const result = await buyBoost(request.user.playerId, boostCode, getConfig());
      if ('error' in result) {
        return reply.code(result.error === 'unknown_boost' ? 404 : 400).send(result);
      }
      return result;
    },
  );

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
      const payload = app.jwt.verify(cookies[ACCESS_COOKIE] ?? '') as AuthTokenPayload;
      const data = socket.data as { playerId: number; username: string };
      data.playerId = payload.playerId;
      data.username = payload.username;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { playerId, username } = socket.data as { playerId: number; username: string };
    void socket.join(playerRoom(playerId));

    // Chat (SPEC §11): join every channel room and immediately serve each
    // channel's recent history from the ring buffer (fast, no DB on connect).
    const channels = allowedChannels();
    for (const channel of channels) void socket.join(chatRoom(channel));
    socket.emit('hello', { playerId, online: onlineCount(), channels });
    for (const channel of channels) {
      socket.emit('chat:history', { channel, messages: recentHistory(channel) });
    }

    // Bootstrap (SPEC §13): deliver the player summary, content catalog, and
    // housing/boss state over the socket so the SPA needs no HTTP GETs to load.
    void (async () => {
      const cfg = getConfig();
      const [me, housing, boss] = await Promise.all([
        getPlayerSummary(playerId),
        getHousing(playerId, cfg),
        getBoss(playerId),
      ]);
      socket.emit('sync', { me, catalog: buildCatalog(), housing, boss });
    })();

    socket.on('ping', (data: { t?: number } | undefined) => {
      socket.emit('pong', { t: data?.t ?? null });
    });

    // Incoming chat is genuinely real-time, so it arrives over the authenticated
    // socket (not HTTP) and is broadcast to the channel room. Persistence +
    // rate-limit happen in the service; errors are relayed only to the sender.
    socket.on('chat:send', (data: { channel?: unknown; body?: unknown } | undefined) => {
      const channel = typeof data?.channel === 'string' ? data.channel : '';
      const body = typeof data?.body === 'string' ? data.body : '';
      void sendMessage(playerId, username, channel, body, Date.now()).then((result) => {
        if ('error' in result) {
          socket.emit('chat:error', { channel, error: result.error });
        } else {
          broadcastToChannel(result.channel, 'chat:message', result);
        }
      });
    });
  });

  setRealtime(io);
  return app;
}
