-- Module 08 sandbox payments. No card data. No change to earlier tables.

CREATE TABLE payment_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  purpose text NOT NULL,
  amount numeric(20, 4) NOT NULL,
  currency text NOT NULL,
  provider text NOT NULL,
  provider_ref text NOT NULL UNIQUE,
  price_version_id uuid REFERENCES product_price_versions (id) ON DELETE RESTRICT,
  subscription_charge_id uuid REFERENCES subscription_charges (id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_charges_purpose_check CHECK (
    purpose IN ('CHALLENGE_PURCHASE', 'SUBSCRIPTION')
  ),
  CONSTRAINT payment_charges_amount_check CHECK (amount > 0),
  CONSTRAINT payment_charges_currency_check CHECK (currency = 'USD'),
  CONSTRAINT payment_charges_provider_check CHECK (provider = 'sandbox'),
  CONSTRAINT payment_charges_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  ),
  CONSTRAINT payment_charges_link_check CHECK (
    (purpose = 'CHALLENGE_PURCHASE' AND price_version_id IS NOT NULL AND subscription_charge_id IS NULL)
    OR (purpose = 'SUBSCRIPTION' AND subscription_charge_id IS NOT NULL AND price_version_id IS NULL)
  )
);

CREATE TRIGGER payment_charges_append_only
  BEFORE UPDATE OR DELETE ON payment_charges
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id uuid NOT NULL REFERENCES payment_charges (id) ON DELETE RESTRICT,
  provider_event_id text NOT NULL UNIQUE,
  outcome text NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_outcome_check CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  CONSTRAINT payment_events_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER payment_events_append_only
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE subscription_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_charge_id uuid NOT NULL UNIQUE REFERENCES subscription_charges (id) ON DELETE RESTRICT,
  payment_event_id uuid NOT NULL UNIQUE REFERENCES payment_events (id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_receipts_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER subscription_receipts_append_only
  BEFORE UPDATE OR DELETE ON subscription_receipts
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE subscription_grace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_charge_id uuid NOT NULL UNIQUE REFERENCES subscription_charges (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  grace_until timestamptz NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_grace_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER subscription_grace_append_only
  BEFORE UPDATE OR DELETE ON subscription_grace
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE human_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  account_id uuid REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT human_review_items_subject_unique UNIQUE (subject_type, subject_id),
  CONSTRAINT human_review_items_subject_check CHECK (subject_type = 'PAYMENT_GRACE_EXPIRY'),
  CONSTRAINT human_review_items_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER human_review_items_append_only
  BEFORE UPDATE OR DELETE ON human_review_items
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();
