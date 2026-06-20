// @eishera/shared — the single home for code shared by server and client.
//
// Three areas live here (populated in later phases, per SPEC §8):
//   - types/      DB row + DTO TypeScript types (hand-maintained).
//   - formulas/   pure formula functions (xpToNext, yieldMult, pRare, duel math).
//                 Written once: the server runs them authoritatively, the client
//                 uses the same functions for smooth optimistic prediction.
//   - constants/  the *type definitions* of balance constants. The numeric values
//                 live in the `game_config` table (live-tunable); these types
//                 describe the shape the config snapshot must satisfy.
//
// Phase 0 ships the skeleton only — no game logic yet.

export * from './types/index.js';
export * from './formulas/index.js';
export * from './constants/index.js';
