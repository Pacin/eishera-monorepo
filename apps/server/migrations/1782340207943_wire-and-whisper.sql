-- Up Migration
-- Social features: player-to-player gold transfers (/wire) and private messages
-- (/whisper). Both keep a durable record in Postgres (the source of truth); the
-- socket layer only delivers them live.

-- gold_transfers — audit ledger for every /wire. The gold itself moves on the
-- players rows inside one transaction; this row is the immutable record of it.
CREATE TABLE gold_transfers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_player BIGINT NOT NULL REFERENCES players (id),
  to_player   BIGINT NOT NULL REFERENCES players (id),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gold_transfers_from ON gold_transfers (from_player, created_at DESC);
CREATE INDEX idx_gold_transfers_to ON gold_transfers (to_player, created_at DESC);

-- direct_messages — durable record of /whisper private messages (moderation +
-- future history). Delivery is live over the socket; this is the persistence.
CREATE TABLE direct_messages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_player BIGINT NOT NULL REFERENCES players (id),
  to_player   BIGINT NOT NULL REFERENCES players (id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dm_to_time ON direct_messages (to_player, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS direct_messages;
DROP TABLE IF EXISTS gold_transfers;
