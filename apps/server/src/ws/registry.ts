// Realtime layer (SPEC §2.1: websocket connections live in memory — rebuildable,
// not authoritative). Backed by Socket.IO. Each connection joins a per-player
// room (`player:<id>`), so pushing to a player is a room emit — no manual socket
// bookkeeping. The tick loop and later phases (chat, boss) push through here.

import type { Server as IOServer } from 'socket.io';

let io: IOServer | null = null;

export const playerRoom = (playerId: number): string => `player:${playerId}`;

/** Register the Socket.IO server instance the app created. */
export function setRealtime(server: IOServer): void {
  io = server;
}

/** Emit an event to every socket a player has open. No-op if realtime is down. */
export function pushToPlayer(playerId: number, event: string, payload: unknown): void {
  io?.to(playerRoom(playerId)).emit(event, payload);
}

/** Total connected sockets across all players. */
export function onlineCount(): number {
  return io?.engine.clientsCount ?? 0;
}

/** Close the realtime server (graceful shutdown). */
export async function closeRealtime(): Promise<void> {
  if (io) {
    await io.close();
    io = null;
  }
}
