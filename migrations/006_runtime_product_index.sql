-- Focused Sales and Pacing need a small product slice across a long date range.
-- Additive only; the date-first and warehouse indexes still serve other views.
CREATE INDEX IF NOT EXISTS byou_summary_product_scope_idx
  ON byou_summary_rows (version_id, grain, pid, date_key, ordinal);
