-- Cash-mismatch lifecycle and stuck-outbox warnings. mismatch_log stays the observation log.

CREATE TABLE mismatch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  outbox_id uuid REFERENCES ledger_outbox (id) ON DELETE RESTRICT,
  expected_amount numeric(20, 4),
  actual_amount numeric(20, 4),
  severity text NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mismatch_events_severity_check CHECK (
    severity IN ('INFO', 'WARNING', 'CRITICAL')
  ),
  CONSTRAINT mismatch_events_type_check CHECK (
    event_type IN ('OBSERVED', 'ESCALATED', 'RESOLVED', 'STALE_OUTBOX')
  ),
  CONSTRAINT mismatch_events_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  ),
  CONSTRAINT mismatch_events_shape_check CHECK (
    (
      event_type = 'STALE_OUTBOX'
      AND outbox_id IS NOT NULL
      AND severity = 'WARNING'
    )
    OR (
      event_type IN ('OBSERVED', 'ESCALATED', 'RESOLVED')
      AND outbox_id IS NULL
      AND expected_amount IS NOT NULL
      AND actual_amount IS NOT NULL
    )
  )
);

CREATE TRIGGER mismatch_events_append_only
  BEFORE UPDATE OR DELETE ON mismatch_events
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE INDEX mismatch_events_account_idx ON mismatch_events (account_id, created_at DESC);
CREATE UNIQUE INDEX mismatch_events_stale_outbox_idx
  ON mismatch_events (outbox_id)
  WHERE event_type = 'STALE_OUTBOX';

CREATE VIEW ledger_anomaly_current AS
SELECT DISTINCT ON (account_id)
  id,
  account_id,
  severity,
  event_type,
  expected_amount,
  actual_amount,
  actor_type,
  created_at
FROM mismatch_events
WHERE event_type IN ('OBSERVED', 'ESCALATED', 'RESOLVED')
ORDER BY account_id, created_at DESC, id DESC;
