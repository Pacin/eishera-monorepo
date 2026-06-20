-- Up Migration
-- Refresh-token store for revocable sessions. Access tokens are short-lived
-- stateless JWTs; refresh tokens are opaque random secrets stored hashed here so
-- they can be rotated and revoked (logout, reuse detection) — all in Postgres,
-- no Redis. Only the SHA-256 hash is stored, never the raw token.

CREATE TABLE auth_refresh_tokens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  BIGINT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_refresh_tokens_player ON auth_refresh_tokens (player_id);

-- Down Migration
DROP TABLE IF EXISTS auth_refresh_tokens;
