// In-memory websocket connection registry (SPEC §2.1 allows websocket
// connections in memory — rebuildable, not authoritative). Maps player id →
// open sockets so later phases can push action results, market fills, chat, and
// boss updates. Phase 2 only populates/depopulates it.

/** The subset of the ws socket API this registry relies on. */
export interface WsLike {
  send(data: string): void;
  close(): void;
}

const connections = new Map<number, Set<WsLike>>();

export function addConnection(playerId: number, socket: WsLike): void {
  let set = connections.get(playerId);
  if (!set) {
    set = new Set();
    connections.set(playerId, set);
  }
  set.add(socket);
}

export function removeConnection(playerId: number, socket: WsLike): void {
  const set = connections.get(playerId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) connections.delete(playerId);
}

export function connectionsFor(playerId: number): ReadonlySet<WsLike> {
  return connections.get(playerId) ?? new Set();
}

/** Total open sockets (across all players). */
export function connectionCount(): number {
  let n = 0;
  for (const set of connections.values()) n += set.size;
  return n;
}
