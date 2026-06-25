// Central game state. The server is authoritative and everything flows over
// Socket.IO (SPEC §13): on connect the server sends a `sync` bootstrap (player,
// catalog, housing, boss), then streams live updates (player:update, battle,
// market:fill, housing:update, boss:update, chat). The SPA performs NO data GETs
// — auth status is derived from the socket handshake, and mutations are HTTP
// POSTs whose responses carry the updated state. Auth POSTs (login/register/
// logout) are the only non-socket calls.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Socket } from 'socket.io-client';
import type {
  PlayerSummary,
  GameCatalog,
  HousingView,
  BossView,
  InventoryView,
  BattleResult,
  GatherResult,
  ChatMessage,
  WhisperMessage,
  WireReceipt,
} from '@eishera/shared';
import { postJson, refreshSession } from './api.js';
import { connectSocket, disconnectSocket } from './socket.js';
import {
  type CombatTracker,
  type GatherTracker,
  emptyCombat,
  emptyGather,
  addBattle,
  addGather,
  loadCombat,
  loadGather,
  saveCombat,
  saveGather,
} from './tracker.js';

type Status = 'loading' | 'anon' | 'authed';

interface MarketFill {
  order_id: number;
  side: string;
  qty: number;
  price: number;
}

interface GameState {
  status: Status;
  me: PlayerSummary | null;
  catalog: GameCatalog | null;
  housing: HousingView | null;
  boss: BossView | null;
  inventory: InventoryView | null;
  battles: BattleResult[];
  /** Latest-first per-action gather/craft summaries (drives the detail view). */
  gathers: GatherResult[];
  /** Persistent local activity tallies (since last reset). */
  combatTracker: CombatTracker;
  gatherTracker: GatherTracker;
  resetCombatTracker: () => void;
  resetGatherTracker: () => void;
  chat: Record<string, ChatMessage[]>;
  chatError: string | null;
  whispers: WhisperMessage[];
  /** Transient feedback for /wire & /whisper (receipts, errors). Auto-cleared. */
  socialNotice: { kind: 'info' | 'error'; text: string } | null;
  lastFill: MarketFill | null;
  connected: boolean;
  /** performance.now() of the last player:update (a processed action) — drives the
   *  action ticker so its 0% lands exactly when actions_remaining decreases. */
  tickAt: number | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  // Mutations: HTTP POSTs whose responses update state (no follow-up GET).
  selectRecipe: (recipeId: number | null) => Promise<void>;
  battle: (monsterId: number) => Promise<void>;
  refill: () => Promise<void>;
  startUpgrade: (featureId: number) => Promise<void>;
  cancelUpgrade: () => Promise<void>;
  joinBoss: () => Promise<void>;
  sendChat: (channel: string, body: string) => void;
  wire: (to: string, amount: number) => void;
  whisper: (to: string, body: string) => void;
}

const Ctx = createContext<GameState | null>(null);

const MAX_BATTLES = 8;
const MAX_GATHERS = 8;
const MAX_CHAT = 80;
const MAX_WHISPERS = 80;

function wireErrorText(error: string): string {
  switch (error) {
    case 'unknown_user':
      return 'No such player to wire to.';
    case 'self':
      return "You can't wire gold to yourself.";
    case 'bad_amount':
      return 'Wire amount must be a whole number above zero.';
    case 'insufficient_gold':
      return 'Not enough gold for that wire.';
    default:
      return 'Wire failed.';
  }
}

function whisperErrorText(error: string): string {
  switch (error) {
    case 'unknown_user':
      return 'No such player to whisper.';
    case 'self':
      return "You can't whisper yourself.";
    case 'empty_message':
      return 'Whisper needs a message.';
    case 'too_long':
      return 'Whisper is too long.';
    case 'rate_limited':
      return 'Slow down — too many whispers.';
    default:
      return 'Whisper failed.';
  }
}

export function GameProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<PlayerSummary | null>(null);
  const [catalog, setCatalog] = useState<GameCatalog | null>(null);
  const [housing, setHousing] = useState<HousingView | null>(null);
  const [boss, setBoss] = useState<BossView | null>(null);
  const [inventory, setInventory] = useState<InventoryView | null>(null);
  const [battles, setBattles] = useState<BattleResult[]>([]);
  const [gathers, setGathers] = useState<GatherResult[]>([]);
  const [combatTracker, setCombatTracker] = useState<CombatTracker>(emptyCombat);
  const [gatherTracker, setGatherTracker] = useState<GatherTracker>(emptyGather);
  const [chat, setChat] = useState<Record<string, ChatMessage[]>>({});
  const [chatError, setChatError] = useState<string | null>(null);
  const [whispers, setWhispers] = useState<WhisperMessage[]>([]);
  const [socialNotice, setSocialNotice] = useState<GameState['socialNotice']>(null);
  const [lastFill, setLastFill] = useState<MarketFill | null>(null);
  const [tickAt, setTickAt] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  // Latest username, read by the wire-receipt handler to phrase direction without
  // re-subscribing the socket listener on every player:update.
  const meNameRef = useRef<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  // Lets the connect_error handler re-invoke setup() (a fresh socket) after a
  // token refresh, without a self-referential useCallback dependency.
  const setupRef = useRef<() => void>(() => {});
  // Guards to a single refresh+reconnect attempt per failure episode (reset on
  // sync / login / logout), so a still-failing handshake can't loop forever.
  const refreshTriedRef = useRef(false);

  // (Re)open the socket and wire every live event. Called on mount, after a
  // successful login/register, and to reconnect with a freshly-refreshed cookie.
  const setupSocket = useCallback(() => {
    disconnectSocket();
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => {
      // The handshake was rejected. The usual cause — even on a fresh page load —
      // is an expired 15-min access token. Try a token refresh first (the 30-day
      // refresh cookie rotates a new access token), then reconnect with a fresh
      // socket (socket.io does NOT auto-recover a handshake-middleware rejection).
      // Only a genuinely failed refresh drops to the login screen; we stay in
      // 'loading' meanwhile so the auth screen never flashes. One attempt per
      // episode — a second failure with a fresh token means we're truly signed out.
      if (refreshTriedRef.current) {
        disconnectSocket();
        socketRef.current = null;
        setStatus('anon');
        return;
      }
      refreshTriedRef.current = true;
      disconnectSocket(); // stop this socket's own retries during the refresh
      socketRef.current = null;
      void refreshSession().then((ok) => {
        if (ok)
          setupRef.current(); // fresh socket → handshake with the new cookie
        else setStatus('anon');
      });
    });

    // Bootstrap: the one payload that replaces all the load-time GETs.
    socket.on(
      'sync',
      (d: {
        me: PlayerSummary;
        catalog: GameCatalog;
        housing: HousingView;
        boss: BossView;
        inventory: InventoryView;
      }) => {
        refreshTriedRef.current = false; // a later expiry may refresh again
        setMe(d.me);
        setCatalog(d.catalog);
        setHousing(d.housing);
        setBoss(d.boss);
        setInventory(d.inventory);
        setStatus('authed');
      },
    );

    // Per-tick authoritative player summary (gold/xp/actions). Re-anchors the ticker.
    socket.on('player:update', (summary: PlayerSummary) => {
      setMe(summary);
      setTickAt(performance.now());
    });
    socket.on('battle', (result: BattleResult) => {
      setBattles((prev) => [result, ...prev].slice(0, MAX_BATTLES));
      setCombatTracker((t) => addBattle(t, result, Date.now()));
    });
    socket.on('gather', (result: GatherResult) => {
      setGathers((prev) => [result, ...prev].slice(0, MAX_GATHERS));
      setGatherTracker((t) => addGather(t, result, Date.now()));
    });
    socket.on('market:fill', (fill: MarketFill) => setLastFill(fill));
    socket.on('housing:update', (view: HousingView) => setHousing(view));
    socket.on('inventory:update', (view: InventoryView) => setInventory(view));
    socket.on('boss:update', (view: BossView) => setBoss(view));
    socket.on('chat:history', (p: { channel: string; messages: ChatMessage[] }) => {
      setChat((prev) => ({ ...prev, [p.channel]: p.messages }));
    });
    socket.on('chat:message', (m: ChatMessage) => {
      setChat((prev) => ({
        ...prev,
        [m.channel]: [...(prev[m.channel] ?? []), m].slice(-MAX_CHAT),
      }));
    });
    socket.on('chat:error', (e: { error: string }) => setChatError(e.error));

    // Whisper history replayed on connect (durable) — authoritative, so replace.
    socket.on('whisper:history', (p: { messages: WhisperMessage[] }) => {
      setWhispers(p.messages.slice(-MAX_WHISPERS));
    });
    // /whisper delivery (both sent-echo and received) → the client 'whisper' lane.
    socket.on('whisper', (m: WhisperMessage) => {
      setWhispers((prev) => [...prev, m].slice(-MAX_WHISPERS));
    });
    // /wire receipt → a transient notice; gold itself refreshes via player:update.
    socket.on('wire', (r: WireReceipt) => {
      const mine = meNameRef.current;
      setSocialNotice({
        kind: 'info',
        text:
          r.from === mine
            ? `Wired ${r.amount.toLocaleString()} gold to ${r.to}.`
            : `Received ${r.amount.toLocaleString()} gold from ${r.from}.`,
      });
    });
    socket.on('wire:error', (e: { error: string }) =>
      setSocialNotice({ kind: 'error', text: wireErrorText(e.error) }),
    );
    socket.on('whisper:error', (e: { error: string }) =>
      setSocialNotice({ kind: 'error', text: whisperErrorText(e.error) }),
    );
  }, []);

  // Keep the username ref current for the wire-receipt direction check.
  useEffect(() => {
    meNameRef.current = me?.username ?? null;
  }, [me?.username]);

  // Load this player's persisted Action Tracker totals when they sign in.
  useEffect(() => {
    if (me?.id == null) return;
    setCombatTracker(loadCombat(me.id));
    setGatherTracker(loadGather(me.id));
  }, [me?.id]);

  // Persist tracker totals as they change (only while signed in).
  useEffect(() => {
    if (me?.id != null) saveCombat(me.id, combatTracker);
  }, [me?.id, combatTracker]);
  useEffect(() => {
    if (me?.id != null) saveGather(me.id, gatherTracker);
  }, [me?.id, gatherTracker]);

  useEffect(() => {
    setupRef.current = setupSocket;
    setupSocket();
    return () => {
      disconnectSocket();
      socketRef.current = null;
    };
  }, [setupSocket]);

  const login = useCallback(
    async (username: string, password: string) => {
      await postJson('/auth/login', { username, password });
      refreshTriedRef.current = false;
      setStatus('loading');
      setupSocket(); // fresh socket carries the new auth cookie → sync → authed
    },
    [setupSocket],
  );
  const register = useCallback(
    async (username: string, password: string) => {
      await postJson('/auth/register', { username, password });
      refreshTriedRef.current = false;
      setStatus('loading');
      setupSocket();
    },
    [setupSocket],
  );
  const logout = useCallback(async () => {
    await postJson('/auth/logout').catch(() => undefined);
    refreshTriedRef.current = false;
    disconnectSocket();
    setMe(null);
    setCatalog(null);
    setHousing(null);
    setBoss(null);
    setInventory(null);
    setGathers([]);
    setBattles([]);
    // In-memory tallies clear; the next sign-in reloads that player's saved totals.
    setCombatTracker(emptyCombat());
    setGatherTracker(emptyGather());
    setStatus('anon');
  }, []);

  const resetCombatTracker = useCallback(() => setCombatTracker(emptyCombat()), []);
  const resetGatherTracker = useCallback(() => setGatherTracker(emptyGather()), []);

  // Mutations — POST, then apply the response (the server returns the new state).
  const selectRecipe = useCallback(async (recipeId: number | null) => {
    try {
      setMe(await postJson<PlayerSummary>('/actions/select', { recipeId }));
    } catch {
      /* rejected — state unchanged */
    }
  }, []);
  const battle = useCallback(async (monsterId: number) => {
    try {
      setMe(await postJson<PlayerSummary>('/actions/battle', { monsterId }));
    } catch {
      /* rejected */
    }
  }, []);
  const refill = useCallback(async () => {
    try {
      setMe(await postJson<PlayerSummary>('/actions/refresh'));
    } catch {
      /* rejected */
    }
  }, []);
  const startUpgrade = useCallback(async (featureId: number) => {
    try {
      setHousing(await postJson<HousingView>('/housing/upgrade', { featureId }));
    } catch {
      /* rejected — e.g. insufficient funds */
    }
  }, []);
  const cancelUpgrade = useCallback(async () => {
    try {
      const r = await postJson<{ view: HousingView }>('/housing/cancel');
      setHousing(r.view);
    } catch {
      /* rejected */
    }
  }, []);
  const joinBoss = useCallback(async () => {
    try {
      setBoss(await postJson<BossView>('/boss/join'));
    } catch {
      /* rejected */
    }
  }, []);

  const sendChat = useCallback((channel: string, body: string) => {
    setChatError(null);
    socketRef.current?.emit('chat:send', { channel, body });
  }, []);
  const wire = useCallback((to: string, amount: number) => {
    setSocialNotice(null);
    socketRef.current?.emit('wire:send', { to, amount });
  }, []);
  const whisper = useCallback((to: string, body: string) => {
    setSocialNotice(null);
    socketRef.current?.emit('whisper:send', { to, body });
  }, []);

  const value = useMemo<GameState>(
    () => ({
      status,
      me,
      catalog,
      housing,
      boss,
      inventory,
      battles,
      gathers,
      combatTracker,
      gatherTracker,
      resetCombatTracker,
      resetGatherTracker,
      chat,
      chatError,
      whispers,
      socialNotice,
      lastFill,
      connected,
      tickAt,
      login,
      register,
      logout,
      selectRecipe,
      battle,
      refill,
      startUpgrade,
      cancelUpgrade,
      joinBoss,
      sendChat,
      wire,
      whisper,
    }),
    [
      status,
      me,
      catalog,
      housing,
      boss,
      inventory,
      battles,
      gathers,
      combatTracker,
      gatherTracker,
      resetCombatTracker,
      resetGatherTracker,
      chat,
      chatError,
      whispers,
      socialNotice,
      lastFill,
      connected,
      tickAt,
      login,
      register,
      logout,
      selectRecipe,
      battle,
      refill,
      startUpgrade,
      cancelUpgrade,
      joinBoss,
      sendChat,
      wire,
      whisper,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGame(): GameState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}
