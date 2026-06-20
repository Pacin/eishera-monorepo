import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy API + websocket to the backend so the SPA and server share an origin in
// dev. Same-origin keeps SameSite=Strict auth cookies working without HTTPS.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: API_TARGET, changeOrigin: true },
      '/me': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
});
