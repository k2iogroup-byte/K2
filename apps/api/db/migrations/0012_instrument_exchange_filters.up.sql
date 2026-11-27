-- Binance spot filters for crypto instruments.
-- numeric(24,8) on quotes and fills already stores a price of 0.00000123,
-- a price of 100000, and a quantity in the billions. This table keeps the
-- exchange filter text exactly, including a tick or step finer than scale 8.
-- Existing tables and constraints are unchanged.

CREATE TABLE instrument_exchange_filters (
  instrument_id uuid PRIMARY KEY REFERENCES instruments (id) ON DELETE RESTRICT,
  base_asset text NOT NULL,
  quote_asset text NOT NULL,
  tick_size text NOT NULL,
  step_size text NOT NULL,
  min_qty text NOT NULL,
  max_qty text NOT NULL,
  min_notional text NOT NULL,
  exchange_status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instrument_exchange_filters_base_check CHECK (base_asset ~ '^[A-Z0-9]{1,16}$'),
  CONSTRAINT instrument_exchange_filters_quote_check CHECK (quote_asset = 'USDT'),
  CONSTRAINT instrument_exchange_filters_decimal_check CHECK (
    tick_size ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
    AND step_size ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
    AND min_qty ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
    AND max_qty ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
    AND min_notional ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
  ),
  CONSTRAINT instrument_exchange_filters_status_check CHECK (
    exchange_status IN ('TRADING', 'BREAK', 'HALT', 'DELISTED')
  )
);

COMMENT ON TABLE instrument_exchange_filters IS
  'Exact Binance filter strings. price_scale stays at most 8 because numeric(24,8) already holds 0.00000123 and 100000.';
