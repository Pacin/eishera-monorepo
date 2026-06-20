-- Up Migration
-- config_audit (SPEC §3.2) plus a single generic trigger that, for every config
-- table, (1) records the change in config_audit and (2) signals the running
-- server via pg_notify('config_changed', …). Because this lives at the DB level
-- it fires for ANY writer — the app's config service AND direct admin edits in
-- psql alike (SPEC §4: "live-editable … without restart").
--
-- Two session GUCs cooperate with it:
--   app.changed_by              -> recorded as config_audit.changed_by
--   app.suppress_config_events  -> when 'on', skip audit+notify (used by the seed)

CREATE TABLE config_audit (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL,
  key_or_id  TEXT,
  old_value  JSONB,
  new_value  JSONB,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_config_audit_table_time ON config_audit (table_name, changed_at DESC);

CREATE FUNCTION config_audit_notify() RETURNS trigger AS $$
DECLARE
  v_key TEXT;
  v_old JSONB;
  v_new JSONB;
BEGIN
  -- Bulk loaders (the seed) suppress both audit noise and reload storms.
  IF current_setting('app.suppress_config_events', TRUE) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_new := NULL;
    v_key := v_old ->> TG_ARGV[0];
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_key := v_new ->> TG_ARGV[0];
  ELSE -- INSERT
    v_old := NULL;
    v_new := to_jsonb(NEW);
    v_key := v_new ->> TG_ARGV[0];
  END IF;

  INSERT INTO config_audit (table_name, key_or_id, old_value, new_value, changed_by)
  VALUES (TG_TABLE_NAME, v_key, v_old, v_new, current_setting('app.changed_by', TRUE));

  PERFORM pg_notify(
    'config_changed',
    json_build_object('table', TG_TABLE_NAME, 'key', v_key, 'op', TG_OP)::text
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- One trigger per config table; the argument names the natural-key column.
CREATE TRIGGER trg_audit_skills AFTER INSERT OR UPDATE OR DELETE ON skills
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('code');
CREATE TRIGGER trg_audit_items AFTER INSERT OR UPDATE OR DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('code');
CREATE TRIGGER trg_audit_rarities AFTER INSERT OR UPDATE OR DELETE ON rarities
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('tier');
CREATE TRIGGER trg_audit_activities AFTER INSERT OR UPDATE OR DELETE ON activities
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('code');
CREATE TRIGGER trg_audit_recipes AFTER INSERT OR UPDATE OR DELETE ON recipes
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('code');
CREATE TRIGGER trg_audit_monsters AFTER INSERT OR UPDATE OR DELETE ON monsters
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('id');
CREATE TRIGGER trg_audit_housing_features AFTER INSERT OR UPDATE OR DELETE ON housing_features
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('code');
CREATE TRIGGER trg_audit_global_boosts AFTER INSERT OR UPDATE OR DELETE ON global_boosts
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('code');
CREATE TRIGGER trg_audit_game_config AFTER INSERT OR UPDATE OR DELETE ON game_config
  FOR EACH ROW EXECUTE FUNCTION config_audit_notify('key');

-- Down Migration
DROP TRIGGER IF EXISTS trg_audit_game_config ON game_config;
DROP TRIGGER IF EXISTS trg_audit_global_boosts ON global_boosts;
DROP TRIGGER IF EXISTS trg_audit_housing_features ON housing_features;
DROP TRIGGER IF EXISTS trg_audit_monsters ON monsters;
DROP TRIGGER IF EXISTS trg_audit_recipes ON recipes;
DROP TRIGGER IF EXISTS trg_audit_activities ON activities;
DROP TRIGGER IF EXISTS trg_audit_rarities ON rarities;
DROP TRIGGER IF EXISTS trg_audit_items ON items;
DROP TRIGGER IF EXISTS trg_audit_skills ON skills;
DROP FUNCTION IF EXISTS config_audit_notify();
DROP TABLE IF EXISTS config_audit;
