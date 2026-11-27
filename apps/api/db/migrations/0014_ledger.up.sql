-- Module 07 journal. Module 05 outbox rows stay as they are.
-- posted_at on ledger_outbox is still set by the drainer, once.

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  entry_type text NOT NULL,
  amount numeric(20, 4) NOT NULL,
  cash_effect boolean NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  outbox_id uuid REFERENCES ledger_outbox (id) ON DELETE RESTRICT,
  execution_id uuid REFERENCES executions (id) ON DELETE RESTRICT,
  reverses_id uuid,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_type_check CHECK (
    entry_type IN ('OPENING', 'FILL', 'COMMISSION', 'SUBSCRIPTION', 'REVERSAL')
  ),
  CONSTRAINT journal_entries_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_reverses_fk
  FOREIGN KEY (reverses_id) REFERENCES journal_entries (id) ON DELETE RESTRICT;

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE INDEX journal_entries_cash_idx ON journal_entries (account_id) WHERE cash_effect;

CREATE TABLE mismatch_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  expected_amount numeric(20, 4) NOT NULL,
  actual_amount numeric(20, 4) NOT NULL,
  severity text NOT NULL,
  kind text NOT NULL,
  source_module text NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mismatch_log_severity_check CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT mismatch_log_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER mismatch_log_append_only
  BEFORE UPDATE OR DELETE ON mismatch_log
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE VIEW ledger_anomalies AS
SELECT
  id,
  severity,
  created_at,
  account_id,
  expected_amount,
  actual_amount,
  source_module,
  kind,
  actor_type
FROM mismatch_log;

CREATE TABLE ledger_freezes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  mismatch_log_id uuid NOT NULL REFERENCES mismatch_log (id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_freezes_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER ledger_freezes_append_only
  BEFORE UPDATE OR DELETE ON ledger_freezes
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE ledger_freeze_lifts (
  freeze_id uuid PRIMARY KEY REFERENCES ledger_freezes (id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_freeze_lifts_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER ledger_freeze_lifts_append_only
  BEFORE UPDATE OR DELETE ON ledger_freeze_lifts
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE subscription_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount numeric(20, 4) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_charges_amount_check CHECK (amount > 0),
  CONSTRAINT subscription_charges_period_check CHECK (period_end > period_start),
  CONSTRAINT subscription_charges_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER subscription_charges_append_only
  BEFORE UPDATE OR DELETE ON subscription_charges
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();
