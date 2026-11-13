-- Module 03 catalogue, immutable rule-set versions, and challenge account lifecycle.
-- Does not create a ledger, a payment, a subscription, or an evaluation engine.
-- Prices and rule numbers are rows. Pass/fail formulas are not stored because they are unresolved.

CREATE FUNCTION k2_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TABLE challenge_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_size numeric(20, 4) NOT NULL,
  currency text NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_products_size_unique UNIQUE (account_size, currency),
  CONSTRAINT challenge_products_currency_check CHECK (currency = 'USD'),
  CONSTRAINT challenge_products_size_check CHECK (account_size > 0 AND account_size <= 1000000),
  CONSTRAINT challenge_products_removed_sizes CHECK (account_size <> 5000 AND account_size <> 300000)
);

CREATE TABLE product_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES challenge_products (id) ON DELETE RESTRICT,
  price numeric(20, 4) NOT NULL,
  currency text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  decision_ref text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_price_versions_price_check CHECK (price > 0),
  CONSTRAINT product_price_versions_currency_check CHECK (currency = 'USD'),
  CONSTRAINT product_price_versions_window_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT product_price_versions_ref_check CHECK (char_length(decision_ref) BETWEEN 3 AND 64)
);

CREATE UNIQUE INDEX product_price_versions_one_open_idx
  ON product_price_versions (product_id)
  WHERE valid_to IS NULL;

CREATE TABLE product_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES challenge_products (id) ON DELETE RESTRICT,
  active boolean NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_activation_events_key_unique UNIQUE (idempotency_key),
  CONSTRAINT product_activation_events_reason_check CHECK (char_length(reason) BETWEEN 8 AND 500)
);

CREATE INDEX product_activation_events_product_idx
  ON product_activation_events (product_id, effective_at DESC);

CREATE TABLE rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  account_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_sets_code_check CHECK (code ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  CONSTRAINT rule_sets_type_check CHECK (account_type = 'CHALLENGE')
);

CREATE TABLE rule_set_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES rule_sets (id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  decision_ref text NOT NULL,
  published_at timestamptz NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_set_versions_number_unique UNIQUE (rule_set_id, version_number),
  CONSTRAINT rule_set_versions_number_check CHECK (version_number > 0),
  CONSTRAINT rule_set_versions_ref_check CHECK (char_length(decision_ref) BETWEEN 3 AND 64)
);

CREATE TABLE rule_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_version_id uuid NOT NULL REFERENCES rule_set_versions (id) ON DELETE RESTRICT,
  stage text NOT NULL,
  parameter_key text NOT NULL,
  status text NOT NULL,
  numeric_value numeric(20, 4),
  unit text,
  reference_id text NOT NULL,
  CONSTRAINT rule_parameters_unique UNIQUE (rule_set_version_id, stage, parameter_key),
  CONSTRAINT rule_parameters_stage_check CHECK (stage IN ('STAGE_1', 'STAGE_2')),
  CONSTRAINT rule_parameters_status_check CHECK (status IN ('CONFIRMED', 'UNRESOLVED')),
  CONSTRAINT rule_parameters_value_check CHECK (
    (status = 'CONFIRMED' AND numeric_value IS NOT NULL AND unit IS NOT NULL)
    OR (status = 'UNRESOLVED' AND numeric_value IS NULL)
  ),
  CONSTRAINT rule_parameters_unit_check CHECK (
    unit IS NULL OR unit IN ('PCT', 'DAYS', 'USD', 'RATE')
  ),
  CONSTRAINT rule_parameters_ref_check CHECK (char_length(reference_id) BETWEEN 3 AND 64)
);

CREATE TABLE purchase_evidence_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system text NOT NULL,
  idempotency_key text NOT NULL,
  external_reference text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  price_version_id uuid NOT NULL REFERENCES product_price_versions (id) ON DELETE RESTRICT,
  amount numeric(20, 4) NOT NULL,
  currency text NOT NULL,
  verified_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_evidence_source_check CHECK (source_system = 'M-08'),
  CONSTRAINT purchase_evidence_key_unique UNIQUE (idempotency_key),
  CONSTRAINT purchase_evidence_reference_unique UNIQUE (source_system, external_reference),
  CONSTRAINT purchase_evidence_amount_check CHECK (amount > 0),
  CONSTRAINT purchase_evidence_currency_check CHECK (currency = 'USD')
);

CREATE TABLE trading_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  account_type text NOT NULL,
  stage text NOT NULL,
  state text NOT NULL,
  initial_capital numeric(20, 4) NOT NULL,
  currency text NOT NULL,
  product_id uuid NOT NULL REFERENCES challenge_products (id) ON DELETE RESTRICT,
  price_version_id uuid NOT NULL REFERENCES product_price_versions (id) ON DELETE RESTRICT,
  rule_set_version_id uuid NOT NULL REFERENCES rule_set_versions (id) ON DELETE RESTRICT,
  purchase_evidence_id uuid NOT NULL UNIQUE REFERENCES purchase_evidence_references (id) ON DELETE RESTRICT,
  provisioned_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trading_accounts_type_check CHECK (account_type = 'CHALLENGE'),
  CONSTRAINT trading_accounts_stage_check CHECK (stage = 'STAGE_1'),
  CONSTRAINT trading_accounts_state_check CHECK (
    state IN (
      'PROVISIONED',
      'ACTIVE',
      'PASSED',
      'FAILED',
      'EXPIRED',
      'SUSPENDED',
      'UNDER_REVIEW',
      'CLOSED'
    )
  ),
  CONSTRAINT trading_accounts_capital_check CHECK (initial_capital > 0),
  CONSTRAINT trading_accounts_currency_check CHECK (currency = 'USD')
);

CREATE INDEX trading_accounts_user_idx ON trading_accounts (user_id, created_at DESC);

CREATE TABLE account_state_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  from_state text,
  to_state text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL,
  actor_type text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_state_transitions_key_unique UNIQUE (idempotency_key),
  CONSTRAINT account_state_transitions_state_check CHECK (
    to_state IN (
      'PROVISIONED',
      'ACTIVE',
      'PASSED',
      'FAILED',
      'EXPIRED',
      'SUSPENDED',
      'UNDER_REVIEW',
      'CLOSED'
    )
    AND (
      from_state IS NULL
      OR from_state IN (
        'PROVISIONED',
        'ACTIVE',
        'PASSED',
        'FAILED',
        'EXPIRED',
        'SUSPENDED',
        'UNDER_REVIEW',
        'CLOSED'
      )
    )
  ),
  CONSTRAINT account_state_transitions_actor_check CHECK (
    (actor_type = 'SYSTEM' AND actor_user_id IS NULL)
    OR (actor_type = 'STAFF' AND actor_user_id IS NOT NULL)
  ),
  CONSTRAINT account_state_transitions_reason_check CHECK (char_length(reason) BETWEEN 8 AND 500)
);

CREATE INDEX account_state_transitions_account_idx
  ON account_state_transitions (account_id, created_at);

CREATE TABLE challenge_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  target_account_id uuid REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  target_product_id uuid REFERENCES challenge_products (id) ON DELETE RESTRICT,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX challenge_audit_events_created_idx ON challenge_audit_events (created_at DESC);

CREATE TABLE catalogue_commands (
  idempotency_key text PRIMARY KEY,
  command_name text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalogue_commands_hash_check CHECK (char_length(request_hash) = 64)
);

CREATE FUNCTION challenge_products_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_size IS DISTINCT FROM OLD.account_size
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'challenge product commercial terms are immutable';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active AND NOT EXISTS (
    SELECT 1
    FROM product_activation_events AS event
    WHERE event.product_id = NEW.id
      AND event.active = NEW.active
      AND event.effective_at = transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'product activation requires an event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER challenge_products_guard
  BEFORE UPDATE ON challenge_products
  FOR EACH ROW
  EXECUTE FUNCTION challenge_products_guard();

CREATE FUNCTION product_price_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.price IS DISTINCT FROM OLD.price
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.decision_ref IS DISTINCT FROM OLD.decision_ref
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.valid_to IS NOT NULL
    OR NEW.valid_to IS NULL
  THEN
    RAISE EXCEPTION 'product price version is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_price_versions_immutable
  BEFORE UPDATE ON product_price_versions
  FOR EACH ROW
  EXECUTE FUNCTION product_price_versions_immutable();

CREATE FUNCTION trading_accounts_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.account_type IS DISTINCT FROM OLD.account_type
    OR NEW.stage IS DISTINCT FROM OLD.stage
    OR NEW.initial_capital IS DISTINCT FROM OLD.initial_capital
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.price_version_id IS DISTINCT FROM OLD.price_version_id
    OR NEW.rule_set_version_id IS DISTINCT FROM OLD.rule_set_version_id
    OR NEW.purchase_evidence_id IS DISTINCT FROM OLD.purchase_evidence_id
    OR NEW.provisioned_at IS DISTINCT FROM OLD.provisioned_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.id IS DISTINCT FROM OLD.id
  THEN
    RAISE EXCEPTION 'trading account commercial terms are immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS (
    SELECT 1
    FROM account_state_transitions AS transition
    WHERE transition.account_id = NEW.id
      AND transition.from_state = OLD.state
      AND transition.to_state = NEW.state
      AND transition.created_at = transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'state change requires a transition row';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trading_accounts_guard
  BEFORE UPDATE ON trading_accounts
  FOR EACH ROW
  EXECUTE FUNCTION trading_accounts_guard();

CREATE TRIGGER product_activation_events_append_only
  BEFORE UPDATE OR DELETE ON product_activation_events
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER rule_set_versions_append_only
  BEFORE UPDATE OR DELETE ON rule_set_versions
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER rule_parameters_append_only
  BEFORE UPDATE OR DELETE ON rule_parameters
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER purchase_evidence_append_only
  BEFORE UPDATE OR DELETE ON purchase_evidence_references
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER account_state_transitions_append_only
  BEFORE UPDATE OR DELETE ON account_state_transitions
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER challenge_audit_events_append_only
  BEFORE UPDATE OR DELETE ON challenge_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER catalogue_commands_append_only
  BEFORE UPDATE OR DELETE ON catalogue_commands
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

INSERT INTO permissions (code, description) VALUES
  ('accounts.read', 'Read challenge accounts the caller is allowed to see'),
  ('accounts.transition', 'Apply an authorised administrative account transition'),
  ('catalogue.manage', 'Activate products and publish catalogue or rule-set versions');

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'accounts.read' FROM roles;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('ADMIN', 'accounts.transition'),
  ('ADMIN', 'catalogue.manage');

INSERT INTO challenge_products (account_size, currency, active) VALUES
  (10000.0000, 'USD', true),
  (25000.0000, 'USD', true),
  (50000.0000, 'USD', true),
  (100000.0000, 'USD', true),
  (200000.0000, 'USD', true);

INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
SELECT product.id,
  CASE product.account_size
    WHEN 10000 THEN 129.0000
    WHEN 25000 THEN 250.0000
    WHEN 50000 THEN 399.0000
    WHEN 100000 THEN 699.0000
    WHEN 200000 THEN 1200.0000
  END,
  'USD',
  timestamptz '2026-01-01 00:00:00+00',
  CASE product.account_size
    WHEN 10000 THEN 'BR-100'
    WHEN 25000 THEN 'BR-101'
    WHEN 50000 THEN 'BR-102'
    WHEN 100000 THEN 'BR-103'
    WHEN 200000 THEN 'BR-104'
  END
FROM challenge_products AS product;

INSERT INTO product_activation_events (product_id, active, effective_at, reason, idempotency_key)
SELECT product.id,
  true,
  timestamptz '2026-01-01 00:00:00+00',
  'Confirmed challenge catalogue seed',
  'seed-activation-' || product.id::text
FROM challenge_products AS product;

INSERT INTO rule_sets (code, account_type) VALUES ('CHALLENGE_EVALUATION', 'CHALLENGE');

INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
SELECT id, 1, 'D-023', timestamptz '2026-01-01 00:00:00+00'
FROM rule_sets
WHERE code = 'CHALLENGE_EVALUATION';

INSERT INTO rule_parameters (
  rule_set_version_id,
  stage,
  parameter_key,
  status,
  numeric_value,
  unit,
  reference_id
)
SELECT version.id,
  'STAGE_1',
  parameter.parameter_key,
  parameter.status,
  parameter.numeric_value,
  parameter.unit,
  parameter.reference_id
FROM rule_set_versions AS version
CROSS JOIN (
  VALUES
    ('profit_target_pct'::text, 'CONFIRMED'::text, 8.0000::numeric, 'PCT'::text, 'BR-120'::text),
    ('daily_loss_limit_pct', 'CONFIRMED', 5.0000, 'PCT', 'BR-121'),
    ('max_total_drawdown_pct', 'CONFIRMED', 8.0000, 'PCT', 'BR-122'),
    ('min_trading_days', 'CONFIRMED', 7.0000, 'DAYS', 'BR-123'),
    ('max_duration_days', 'CONFIRMED', 30.0000, 'DAYS', 'BR-124'),
    ('opening_commission_pct', 'CONFIRMED', 0.5000, 'PCT', 'BR-207'),
    ('closing_commission_pct', 'CONFIRMED', 0.0000, 'PCT', 'BR-208'),
    ('swap', 'CONFIRMED', 0.0000, 'RATE', 'BR-210'),
    ('subscription_usd_per_1000', 'CONFIRMED', 1.0000, 'USD', 'BR-200'),
    ('subscription_cycle_days', 'CONFIRMED', 30.0000, 'DAYS', 'BR-202'),
    ('drawdown_basis', 'UNRESOLVED', NULL, NULL, 'OQ-001'),
    ('daily_loss_reference', 'UNRESOLVED', NULL, NULL, 'OQ-001'),
    ('daily_reset_at', 'UNRESOLVED', NULL, NULL, 'OQ-001'),
    ('trading_day_definition', 'UNRESOLVED', NULL, NULL, 'OQ-002'),
    ('profit_target_basis', 'UNRESOLVED', NULL, NULL, 'OQ-003'),
    ('duration_clock', 'UNRESOLVED', NULL, NULL, 'OQ-004'),
    ('stage_transition', 'UNRESOLVED', NULL, NULL, 'OQ-005'),
    ('breach_consequence', 'UNRESOLVED', NULL, NULL, 'BR-133'),
    ('commission_market_scope', 'UNRESOLVED', NULL, NULL, 'OQ-012'),
    ('subscription_collection', 'UNRESOLVED', NULL, NULL, 'OQ-010'),
    ('activation_condition', 'UNRESOLVED', NULL, NULL, 'ACTIVATION_CONDITION')
) AS parameter (parameter_key, status, numeric_value, unit, reference_id)
WHERE version.version_number = 1;

INSERT INTO rule_parameters (
  rule_set_version_id,
  stage,
  parameter_key,
  status,
  numeric_value,
  unit,
  reference_id
)
SELECT rule_set_version_id,
  'STAGE_2',
  parameter_key,
  status,
  CASE parameter_key
    WHEN 'profit_target_pct' THEN 5.0000
    WHEN 'max_duration_days' THEN 60.0000
    ELSE numeric_value
  END,
  unit,
  reference_id
FROM rule_parameters
WHERE stage = 'STAGE_1';
