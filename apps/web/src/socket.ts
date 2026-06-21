// Socket.IO client (SPEC §13: live updates over websocket). The connection
// authenticates via the same httpOnly access cookie the HTTP API uses (the
// server verifies it at the handshake), so there is no token to manage here.
// Same-origin in dev via the Vite proxy (`/socket.io`).

import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Connect (idempotent). The cookie is sent automatically on the handshake. */
export function connectSocket(): Socket {
  if (socket) return socket;
  socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
  return socket;
}

export function disconnectSocket(): void {
  socket?.close();
  socket = null;
}
