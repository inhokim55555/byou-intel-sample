CREATE TABLE IF NOT EXISTS byou_dataset_versions (
  id text PRIMARY KEY,
  published_at timestamptz NOT NULL,
  source_schema text NOT NULL,
  status text NOT NULL CHECK (status IN ('loading', 'active', 'superseded')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS byou_runtime_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_version text REFERENCES byou_dataset_versions(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS byou_dataset_blobs (
  version_id text NOT NULL REFERENCES byou_dataset_versions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (version_id, kind)
);

CREATE TABLE IF NOT EXISTS byou_fact_rows (
  version_id text NOT NULL REFERENCES byou_dataset_versions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ordinal integer NOT NULL,
  date_key date,
  pid text NOT NULL DEFAULT '',
  cid text NOT NULL DEFAULT '',
  wid text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  PRIMARY KEY (version_id, kind, ordinal)
);

CREATE TABLE IF NOT EXISTS byou_summary_rows (
  version_id text NOT NULL REFERENCES byou_dataset_versions(id) ON DELETE CASCADE,
  grain text NOT NULL,
  ordinal integer NOT NULL,
  date_key date,
  pid text NOT NULL DEFAULT '',
  cid text NOT NULL DEFAULT '',
  wid text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  PRIMARY KEY (version_id, grain, ordinal)
);

CREATE INDEX IF NOT EXISTS byou_fact_scope_idx ON byou_fact_rows (version_id, kind, date_key, pid, cid);
CREATE INDEX IF NOT EXISTS byou_fact_warehouse_idx ON byou_fact_rows (version_id, kind, wid, date_key);
CREATE INDEX IF NOT EXISTS byou_fact_geo_idx ON byou_fact_rows (version_id, kind, region, state, date_key);
CREATE INDEX IF NOT EXISTS byou_summary_scope_idx ON byou_summary_rows (version_id, grain, date_key, pid, cid);
CREATE INDEX IF NOT EXISTS byou_summary_warehouse_idx ON byou_summary_rows (version_id, grain, wid, date_key);
CREATE INDEX IF NOT EXISTS byou_versions_published_idx ON byou_dataset_versions (published_at DESC);
