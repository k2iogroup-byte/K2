-- Module 06 risk records. Inserts only. Existing tables are unchanged.

CREATE TABLE risk_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  order_id uuid,
  kind text NOT NULL,
  decision text NOT NULL,
  reason_code text NOT NULL,
  equity numeric(20, 4),
  daily_floor numeric(20, 4),
  drawdown_floor numeric(20, 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_decisions_kind_check CHECK (
    kind IN ('PRETRADE', 'BREACH', 'PASS', 'FAIL')
  ),
  CONSTRAINT risk_decisions_decision_check CHECK (decision IN ('APPROVE', 'REJECT'))
);

CREATE TRIGGER risk_decisions_append_only
  BEFORE UPDATE OR DELETE ON risk_decisions
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE risk_day_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  utc_date date NOT NULL,
  kind text NOT NULL,
  mark numeric(20, 4) NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_day_marks_kind_check CHECK (kind = 'EQUITY_HIGH'),
  CONSTRAINT risk_day_marks_mark_check CHECK (mark >= 0)
);

CREATE TRIGGER risk_day_marks_append_only
  BEFORE UPDATE OR DELETE ON risk_day_marks
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE INDEX risk_day_marks_day_idx ON risk_day_marks (account_id, utc_date, mark DESC);

CREATE TABLE risk_breaches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  equity numeric(20, 4),
  floor numeric(20, 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_breaches_kind_check CHECK (kind IN ('DAILY', 'DRAWDOWN', 'TIMEOUT'))
);

CREATE TRIGGER risk_breaches_append_only
  BEFORE UPDATE OR DELETE ON risk_breaches
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE risk_close_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  breach_id uuid NOT NULL REFERENCES risk_breaches (id) ON DELETE RESTRICT,
  position_id uuid NOT NULL REFERENCES positions (id) ON DELETE RESTRICT,
  order_id uuid REFERENCES orders (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_close_attempts_unique UNIQUE (breach_id, position_id)
);

CREATE TRIGGER risk_close_attempts_append_only
  BEFORE UPDATE OR DELETE ON risk_close_attempts
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE risk_close_resolutions (
  attempt_id uuid PRIMARY KEY REFERENCES risk_close_attempts (id) ON DELETE RESTRICT,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_close_resolutions_outcome_check CHECK (outcome IN ('FILLED', 'FAILED'))
);

CREATE TRIGGER risk_close_resolutions_append_only
  BEFORE UPDATE OR DELETE ON risk_close_resolutions
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE risk_trading_days (
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  utc_date date NOT NULL,
  first_execution_id uuid NOT NULL REFERENCES executions (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, utc_date)
);

CREATE TRIGGER risk_trading_days_append_only
  BEFORE UPDATE OR DELETE ON risk_trading_days
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE risk_stage_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  outcome text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_stage_outcomes_outcome_check CHECK (outcome IN ('PASSED', 'FAILED'))
);

CREATE TRIGGER risk_stage_outcomes_append_only
  BEFORE UPDATE OR DELETE ON risk_stage_outcomes
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();
