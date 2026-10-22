CREATE TABLE IF NOT EXISTS byou_inventory_approval_events (
  event_id text PRIMARY KEY,
  event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  request_sha256 text NOT NULL,
  action text NOT NULL CHECK (action IN ('approved', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  source_version text NOT NULL,
  source_published_at timestamptz NOT NULL,
  fact_sha256 text NOT NULL,
  issue_id text NOT NULL,
  issue_code text NOT NULL,
  grain text NOT NULL CHECK (grain = 'physical_warehouse'),
  pid text NOT NULL,
  cid text NOT NULL,
  wid text NOT NULL,
  location text NOT NULL,
  inventory_date date NOT NULL,
  on_hand integer NOT NULL CHECK (on_hand >= 2),
  inventory_status text NOT NULL CHECK (inventory_status = 'On hand'),
  receipt_date date NOT NULL,
  approval_date date NOT NULL,
  expires_on date NOT NULL,
  receipt_reference text NOT NULL,
  adjustment_reason text NOT NULL,
  revocation_reason text NOT NULL DEFAULT '',
  reviewer text NOT NULL,
  actor text NOT NULL,
  CHECK (btrim(idempotency_key) <> ''),
  CHECK (btrim(request_sha256) <> '' AND btrim(fact_sha256) <> ''),
  CHECK (btrim(issue_id) <> '' AND btrim(issue_code) <> ''),
  CHECK (btrim(pid) <> '' AND btrim(cid) <> '' AND btrim(wid) <> ''),
  CHECK (btrim(location) <> ''),
  CHECK (receipt_date >= inventory_date AND receipt_date <= approval_date),
  CHECK (receipt_date >= approval_date - 14),
  CHECK (expires_on >= approval_date AND expires_on <= approval_date + 14),
  CHECK (btrim(receipt_reference) <> '' AND btrim(adjustment_reason) <> ''),
  CHECK (action <> 'revoked' OR btrim(revocation_reason) <> ''),
  CHECK (btrim(reviewer) <> '' AND btrim(actor) <> '')
);

CREATE INDEX IF NOT EXISTS byou_inventory_approval_scope_idx
  ON byou_inventory_approval_events (grain, pid, cid, wid, event_sequence DESC);

CREATE INDEX IF NOT EXISTS byou_inventory_approval_expiry_idx
  ON byou_inventory_approval_events (action, expires_on);

CREATE INDEX IF NOT EXISTS byou_inventory_approval_fact_idx
  ON byou_fact_rows (version_id, kind, pid, cid, wid, date_key DESC);
