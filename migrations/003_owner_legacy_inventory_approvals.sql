DO $migration$
DECLARE
  constraint_row record;
  legacy_constraint_count integer;
BEGIN
  -- The original migration creates this marker and all related changes atomically.
  -- Avoid requesting an exclusive table lock on every subsequent application boot.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'byou_inventory_approval_events'::regclass
      AND conname = 'byou_inventory_approval_evidence_kind_check'
  ) THEN
    RETURN;
  END IF;

ALTER TABLE byou_inventory_approval_events
  ADD COLUMN IF NOT EXISTS evidence_kind text NOT NULL DEFAULT 'receipt_or_count',
  ADD COLUMN IF NOT EXISTS authorization_reference text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS authorization_manifest_sha256 text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_disposition_issue_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_disposition_date date,
  ADD COLUMN IF NOT EXISTS source_disposition_on_hand integer;

ALTER TABLE byou_inventory_approval_events
  ALTER COLUMN receipt_date DROP NOT NULL;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'byou_inventory_approval_events'::regclass
      AND conname = 'byou_inventory_approval_evidence_kind_check'
  ) THEN
    SELECT COUNT(*)::integer
    INTO legacy_constraint_count
    FROM pg_constraint
    WHERE conrelid = 'byou_inventory_approval_events'::regclass
      AND contype = 'c'
      AND (
        (cardinality(conkey) = 1 AND pg_get_constraintdef(oid) LIKE '%on_hand >= 2%')
        OR (
          cardinality(conkey) = 2
          AND pg_get_constraintdef(oid) LIKE '%btrim(receipt_reference)%'
          AND pg_get_constraintdef(oid) LIKE '%btrim(adjustment_reason)%'
        )
      );
    IF legacy_constraint_count <> 2 THEN
      RAISE EXCEPTION 'Expected exactly two legacy inventory-approval checks, found %', legacy_constraint_count;
    END IF;

    FOR constraint_row IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'byou_inventory_approval_events'::regclass
        AND contype = 'c'
        AND (
          (cardinality(conkey) = 1 AND pg_get_constraintdef(oid) LIKE '%on_hand >= 2%')
          OR (
            cardinality(conkey) = 2
            AND pg_get_constraintdef(oid) LIKE '%btrim(receipt_reference)%'
            AND pg_get_constraintdef(oid) LIKE '%btrim(adjustment_reason)%'
          )
        )
    LOOP
      EXECUTE format(
        'ALTER TABLE byou_inventory_approval_events DROP CONSTRAINT %I',
        constraint_row.conname
      );
    END LOOP;

    EXECUTE $ddl$
      ALTER TABLE byou_inventory_approval_events
        ADD CONSTRAINT byou_inventory_approval_evidence_kind_check
          CHECK (evidence_kind IN ('receipt_or_count', 'owner_legacy_attestation')),
        ADD CONSTRAINT byou_inventory_approval_balance_check
          CHECK (
            (evidence_kind = 'receipt_or_count' AND on_hand >= 2)
            OR (evidence_kind = 'owner_legacy_attestation' AND on_hand >= 1)
          ),
        ADD CONSTRAINT byou_inventory_approval_receipt_evidence_check
          CHECK (
            evidence_kind <> 'receipt_or_count'
            OR (
              receipt_date IS NOT NULL
              AND receipt_date >= inventory_date
              AND receipt_date <= approval_date
              AND receipt_date >= approval_date - 14
              AND btrim(receipt_reference) <> ''
            )
          ),
        ADD CONSTRAINT byou_inventory_approval_owner_evidence_check
          CHECK (
            evidence_kind <> 'owner_legacy_attestation'
            OR (
              receipt_date IS NULL
              AND btrim(receipt_reference) = ''
              AND btrim(authorization_reference) <> ''
              AND authorization_manifest_sha256 ~ '^[0-9a-f]{64}$'
              AND btrim(source_disposition_issue_id) <> ''
              AND source_disposition_date IS NOT NULL
              AND source_disposition_on_hand IS NOT NULL
              AND source_disposition_on_hand >= 0
              AND inventory_date >= source_disposition_date
              AND abs(on_hand - source_disposition_on_hand) < 250
            )
          ),
        ADD CONSTRAINT byou_inventory_approval_reason_check
          CHECK (btrim(adjustment_reason) <> '')
    $ddl$;
  END IF;
END;
$migration$;
