-- Deferred risk-reducing closes and their price audit. Does not change 0001–0009.

CREATE TABLE deferred_closes (
  order_id uuid PRIMARY KEY REFERENCES orders (id) ON DELETE RESTRICT,
  position_id uuid NOT NULL REFERENCES positions (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  quantity numeric(24, 8) NOT NULL,
  state text NOT NULL DEFAULT 'AWAITING_FRESH',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deferred_closes_state_check CHECK (state IN ('AWAITING_FRESH', 'FILLED')),
  CONSTRAINT deferred_closes_quantity_check CHECK (quantity > 0)
);

CREATE INDEX deferred_closes_instrument_idx
  ON deferred_closes (instrument_id)
  WHERE state = 'AWAITING_FRESH';

CREATE TABLE risk_reducing_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  price_basis text NOT NULL,
  quote_age_acceptance_ms bigint,
  quote_age_fill_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_reducing_audits_basis_check CHECK (
    price_basis IN ('FRESH', 'DEFERRED_FRESH', 'ENTRY_FALLBACK')
  ),
  CONSTRAINT risk_reducing_audits_age_check CHECK (
    (quote_age_acceptance_ms IS NULL OR quote_age_acceptance_ms >= 0)
    AND (quote_age_fill_ms IS NULL OR quote_age_fill_ms >= 0)
  )
);
