CREATE TABLE IF NOT EXISTS byou_pnl_imports (
  import_id text PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('forecast', 'payments', 'actuals')),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  source_as_of date NOT NULL,
  schema_name text NOT NULL CHECK (schema_name = 'byou-pnl-import-v1'),
  normalized_payload jsonb NOT NULL,
  superseded_payload jsonb NOT NULL DEFAULT '[]'::jsonb,
  normalized_row_count integer NOT NULL CHECK (normalized_row_count > 0),
  actor_email text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_sha256)
);

ALTER TABLE byou_pnl_imports
  ADD COLUMN IF NOT EXISTS superseded_payload jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS byou_pnl_imports_latest_idx
  ON byou_pnl_imports (source_kind, imported_at DESC);

CREATE TABLE IF NOT EXISTS byou_pnl_override_events (
  event_id text PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('set', 'reverse')),
  target_event_id text,
  pid text NOT NULL DEFAULT '',
  cid text NOT NULL DEFAULT '',
  field_key text NOT NULL DEFAULT '',
  numeric_value numeric,
  superseded_value numeric,
  effective_date date,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  actor_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (action = 'set' AND target_event_id IS NULL AND pid <> '' AND cid <> '' AND field_key <> '' AND numeric_value >= 0 AND effective_date IS NOT NULL)
    OR
    (action = 'reverse' AND target_event_id IS NOT NULL AND target_event_id <> '')
  )
);

ALTER TABLE byou_pnl_override_events
  ADD COLUMN IF NOT EXISTS superseded_value numeric;

CREATE INDEX IF NOT EXISTS byou_pnl_override_scope_idx
  ON byou_pnl_override_events (pid, cid, field_key, effective_date, created_at);

DROP INDEX IF EXISTS byou_pnl_override_target_idx;
CREATE UNIQUE INDEX byou_pnl_override_target_idx
  ON byou_pnl_override_events (target_event_id)
  WHERE action = 'reverse' AND target_event_id IS NOT NULL;

ALTER TABLE byou_pnl_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE byou_pnl_override_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE byou_pnl_imports, byou_pnl_override_events FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE byou_pnl_imports, byou_pnl_override_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE byou_pnl_imports, byou_pnl_override_events FROM authenticated;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION byou_pnl_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'BYOU P&L records are append-only; append a reversal or replacement event instead';
END;
$$;

DROP TRIGGER IF EXISTS byou_pnl_imports_append_only ON byou_pnl_imports;
CREATE TRIGGER byou_pnl_imports_append_only
  BEFORE UPDATE OR DELETE ON byou_pnl_imports
  FOR EACH ROW EXECUTE FUNCTION byou_pnl_reject_mutation();

DROP TRIGGER IF EXISTS byou_pnl_overrides_append_only ON byou_pnl_override_events;
CREATE TRIGGER byou_pnl_overrides_append_only
  BEFORE UPDATE OR DELETE ON byou_pnl_override_events
  FOR EACH ROW EXECUTE FUNCTION byou_pnl_reject_mutation();
