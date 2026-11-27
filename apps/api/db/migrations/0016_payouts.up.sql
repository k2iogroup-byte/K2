-- Module 09 payouts and the generic human-review queue.
-- human_review_items stays payment-only. Widening its check would alter migration 0015.

CREATE TABLE funded_activations (
  account_id uuid PRIMARY KEY REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funded_activations_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER funded_activations_append_only
  BEFORE UPDATE OR DELETE ON funded_activations
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE human_review_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  account_id uuid REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT human_review_cases_subject_unique UNIQUE (subject_type, subject_id),
  CONSTRAINT human_review_cases_subject_check CHECK (
    subject_type IN ('PAYMENT_GRACE_EXPIRY', 'PAYOUT', 'KYC')
  ),
  CONSTRAINT human_review_cases_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER human_review_cases_append_only
  BEFORE UPDATE OR DELETE ON human_review_cases
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE human_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES human_review_cases (id) ON DELETE RESTRICT,
  decision text NOT NULL,
  actor_type text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT human_review_decisions_decision_check CHECK (
    decision IN ('APPROVED', 'REJECTED', 'VERIFIED')
  ),
  CONSTRAINT human_review_decisions_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  ),
  CONSTRAINT human_review_decisions_reason_check CHECK (
    decision <> 'REJECTED' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

CREATE TRIGGER human_review_decisions_append_only
  BEFORE UPDATE OR DELETE ON human_review_decisions
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  gross_profit numeric(20, 4) NOT NULL,
  trader_amount numeric(20, 4) NOT NULL,
  company_amount numeric(20, 4) NOT NULL,
  reserve_amount numeric(20, 4) NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_requests_amount_check CHECK (
    gross_profit > 0 AND trader_amount > 0 AND company_amount >= 0 AND reserve_amount >= 0
  ),
  CONSTRAINT payout_requests_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER payout_requests_append_only
  BEFORE UPDATE OR DELETE ON payout_requests
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE payout_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES payout_requests (id) ON DELETE RESTRICT,
  status text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_type text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_audit_status_check CHECK (
    status IN ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAID')
  ),
  CONSTRAINT payout_audit_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  ),
  CONSTRAINT payout_audit_reason_check CHECK (
    status <> 'REJECTED' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

CREATE TRIGGER payout_audit_append_only
  BEFORE UPDATE OR DELETE ON payout_audit
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE journal_supplements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  payout_request_id uuid NOT NULL REFERENCES payout_requests (id) ON DELETE RESTRICT,
  entry_type text NOT NULL,
  amount numeric(20, 4) NOT NULL,
  cash_effect boolean NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_supplements_type_check CHECK (
    entry_type IN ('PAYOUT_TRADER', 'PAYOUT_COMPANY', 'PAYOUT_RESERVE')
  ),
  CONSTRAINT journal_supplements_amount_check CHECK (amount > 0),
  CONSTRAINT journal_supplements_cash_check CHECK (cash_effect = false),
  CONSTRAINT journal_supplements_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER journal_supplements_append_only
  BEFORE UPDATE OR DELETE ON journal_supplements
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE sandbox_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_request_id uuid NOT NULL UNIQUE REFERENCES payout_requests (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  amount numeric(20, 4) NOT NULL,
  currency text NOT NULL,
  provider text NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_payouts_amount_check CHECK (amount > 0),
  CONSTRAINT sandbox_payouts_currency_check CHECK (currency = 'USD'),
  CONSTRAINT sandbox_payouts_provider_check CHECK (provider = 'sandbox'),
  CONSTRAINT sandbox_payouts_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER sandbox_payouts_append_only
  BEFORE UPDATE OR DELETE ON sandbox_payouts
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

-- KYC status source for the payout gate. Module 10 writes the lifecycle. No document bytes.
CREATE TABLE kyc_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_ref text NOT NULL UNIQUE,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_cases_provider_check CHECK (provider = 'sandbox'),
  CONSTRAINT kyc_cases_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER kyc_cases_append_only
  BEFORE UPDATE OR DELETE ON kyc_cases
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE kyc_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES kyc_cases (id) ON DELETE RESTRICT,
  status text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_type text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_events_status_check CHECK (
    status IN ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED')
  ),
  CONSTRAINT kyc_events_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  ),
  CONSTRAINT kyc_events_reason_check CHECK (
    status <> 'REJECTED' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

CREATE TRIGGER kyc_events_append_only
  BEFORE UPDATE OR DELETE ON kyc_events
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TABLE kyc_document_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES kyc_cases (id) ON DELETE RESTRICT,
  provider_document_id text NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_document_refs_id_check CHECK (length(btrim(provider_document_id)) > 0),
  CONSTRAINT kyc_document_refs_actor_check CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'SUPER_ADMIN')
  )
);

CREATE TRIGGER kyc_document_refs_append_only
  BEFORE UPDATE OR DELETE ON kyc_document_refs
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();
