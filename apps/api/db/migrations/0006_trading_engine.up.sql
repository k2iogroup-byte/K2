-- Module 05 trading records. Not a ledger and not a risk engine.
-- One row per account and instrument on positions, so a later partial unique
-- index on an open position can be added without rewriting this table.
-- Enforcement of "one open position per asset" is not applied here.

ALTER TABLE instruments
  ADD COLUMN trading_status text NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN quote_asset text;

ALTER TABLE instruments
  ADD CONSTRAINT instruments_trading_status_check
    CHECK (trading_status IN ('DISABLED', 'TRADABLE', 'HALTED')),
  ADD CONSTRAINT instruments_quote_asset_check
    CHECK (quote_asset IS NULL OR quote_asset ~ '^[A-Z0-9]{2,16}$');

CREATE SEQUENCE order_accept_sequence AS bigint;

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  client_order_id text NOT NULL,
  accept_sequence bigint NOT NULL DEFAULT nextval('order_accept_sequence'),
  side text NOT NULL,
  order_type text NOT NULL,
  state text NOT NULL,
  quantity numeric(24, 8) NOT NULL,
  filled_quantity numeric(24, 8) NOT NULL DEFAULT 0,
  limit_price numeric(24, 8),
  cash_reserved numeric(20, 4) NOT NULL DEFAULT 0,
  sell_reserved numeric(24, 8) NOT NULL DEFAULT 0,
  reject_reason text,
  risk_decision_id uuid,
  quote_asset text NOT NULL,
  price_origin text NOT NULL,
  live_market_data boolean NOT NULL DEFAULT false,
  feed_state text NOT NULL,
  received_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_client_unique UNIQUE (account_id, client_order_id),
  CONSTRAINT orders_accept_unique UNIQUE (accept_sequence),
  CONSTRAINT orders_side_check CHECK (side IN ('BUY', 'SELL')),
  CONSTRAINT orders_type_check CHECK (order_type IN ('MARKET', 'LIMIT')),
  CONSTRAINT orders_state_check CHECK (
    state IN ('REJECTED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED')
  ),
  CONSTRAINT orders_quantity_check CHECK (
    quantity > 0 AND filled_quantity >= 0 AND filled_quantity <= quantity
  ),
  CONSTRAINT orders_reserve_check CHECK (cash_reserved >= 0 AND sell_reserved >= 0),
  CONSTRAINT orders_live_check CHECK (NOT (price_origin = 'TEST_FIXTURE' AND live_market_data)),
  CONSTRAINT orders_origin_check CHECK (price_origin IN ('TEST_FIXTURE', 'VENDOR')),
  CONSTRAINT orders_quote_asset_check CHECK (quote_asset ~ '^[A-Z0-9]{2,16}$')
);

CREATE INDEX orders_account_created_idx ON orders (account_id, created_at DESC);
CREATE INDEX orders_open_queue_idx ON orders (accept_sequence)
  WHERE state IN ('OPEN', 'PARTIALLY_FILLED');
CREATE INDEX orders_account_instrument_state_idx ON orders (account_id, instrument_id, state);

CREATE TABLE order_state_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  from_state text,
  to_state text NOT NULL,
  reason text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_state_transitions_key_unique UNIQUE (idempotency_key)
);

CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  sequence_no integer NOT NULL,
  quantity numeric(24, 8) NOT NULL,
  price numeric(24, 8) NOT NULL,
  notional numeric(20, 4) NOT NULL,
  commission numeric(20, 4) NOT NULL DEFAULT 0,
  quote_update_id text NOT NULL,
  received_at timestamptz NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  price_origin text NOT NULL,
  live_market_data boolean NOT NULL DEFAULT false,
  execution_venue text NOT NULL DEFAULT 'K2_SIMULATION',
  CONSTRAINT executions_fill_key UNIQUE (order_id, quote_update_id),
  CONSTRAINT executions_sequence_unique UNIQUE (order_id, sequence_no),
  CONSTRAINT executions_quantity_check CHECK (quantity > 0 AND price > 0),
  CONSTRAINT executions_money_check CHECK (notional >= 0 AND commission >= 0),
  CONSTRAINT executions_live_check CHECK (NOT (price_origin = 'TEST_FIXTURE' AND live_market_data)),
  CONSTRAINT executions_venue_check CHECK (execution_venue = 'K2_SIMULATION')
);

CREATE TABLE positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  status text NOT NULL,
  quantity numeric(24, 8) NOT NULL,
  reserved_sell numeric(24, 8) NOT NULL DEFAULT 0,
  average_entry numeric(24, 8) NOT NULL DEFAULT 0,
  cost_basis numeric(20, 4) NOT NULL DEFAULT 0,
  realized_pnl numeric(20, 4) NOT NULL DEFAULT 0,
  opened_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT positions_account_instrument_unique UNIQUE (account_id, instrument_id),
  CONSTRAINT positions_status_check CHECK (status IN ('OPEN', 'CLOSED')),
  CONSTRAINT positions_quantity_check CHECK (
    quantity >= 0 AND reserved_sell >= 0 AND reserved_sell <= quantity
  ),
  CONSTRAINT positions_closed_check CHECK (
    status = 'OPEN' OR (quantity = 0 AND reserved_sell = 0)
  )
);

COMMENT ON TABLE positions IS
  'One row per account and instrument. A later partial unique index for a single open position can be added on top.';

CREATE TABLE position_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES positions (id) ON DELETE RESTRICT,
  execution_id uuid NOT NULL UNIQUE REFERENCES executions (id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  quantity_after numeric(24, 8) NOT NULL,
  cost_basis_after numeric(20, 4) NOT NULL,
  realized_delta numeric(20, 4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_events_type_check CHECK (
    event_type IN ('OPEN', 'INCREASE', 'REDUCE', 'CLOSE', 'REOPEN')
  )
);

CREATE TABLE simulation_cash_projections (
  account_id uuid PRIMARY KEY REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  cash numeric(20, 4) NOT NULL,
  reserved_cash numeric(20, 4) NOT NULL DEFAULT 0,
  event_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulation_cash_nonnegative CHECK (
    cash >= 0 AND reserved_cash >= 0 AND cash >= reserved_cash
  )
);

COMMENT ON TABLE simulation_cash_projections IS
  'Simulation projection only. Not a ledger balance.';

CREATE TABLE simulation_cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_key text NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  amount numeric(20, 4) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simulation_cash_movements_currency_check CHECK (currency = 'USD')
);

CREATE TABLE trading_commands (
  idempotency_key text PRIMARY KEY,
  command_name text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trading_commands_hash_check CHECK (char_length(request_hash) = 64)
);

CREATE TABLE trading_event_counters (
  account_id uuid PRIMARY KEY REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL
);

CREATE TABLE trading_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  sequence_no bigint NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trading_events_sequence_unique UNIQUE (account_id, sequence_no)
);

CREATE TABLE execution_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  account_id uuid REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  order_id uuid REFERENCES orders (id) ON DELETE RESTRICT,
  risk_decision_id uuid,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE risk_authorization_log (
  decision_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  mode text NOT NULL,
  decision text NOT NULL,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_authorization_decision_check CHECK (decision IN ('APPROVE', 'REJECT'))
);

CREATE TABLE ledger_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  execution_id uuid REFERENCES executions (id) ON DELETE RESTRICT,
  amount numeric(20, 4) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  CONSTRAINT ledger_outbox_currency_check CHECK (currency = 'USD')
);

COMMENT ON TABLE ledger_outbox IS
  'Intent rows for Module 07. Module 05 does not set posted_at and does not post a journal.';

CREATE TABLE commission_market_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_version_id uuid NOT NULL REFERENCES rule_set_versions (id) ON DELETE RESTRICT,
  market text NOT NULL,
  decision_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_market_scopes_unique UNIQUE (rule_set_version_id, market),
  CONSTRAINT commission_market_scopes_market_check CHECK (market IN ('EQUITIES', 'CRYPTO'))
);

CREATE TABLE execution_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_number integer NOT NULL UNIQUE,
  slippage_bps numeric(20, 4),
  decision_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE liquidity_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE REFERENCES executions (id) ON DELETE RESTRICT,
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  book_side text NOT NULL,
  price numeric(24, 8) NOT NULL,
  displayed_qty numeric(24, 8) NOT NULL,
  consumed_before numeric(24, 8) NOT NULL,
  take_qty numeric(24, 8) NOT NULL,
  consumed_after numeric(24, 8) NOT NULL,
  accept_sequence bigint NOT NULL,
  quote_update_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT liquidity_allocations_side_check CHECK (book_side IN ('BID', 'ASK')),
  CONSTRAINT liquidity_allocations_qty_check CHECK (
    displayed_qty >= 0
    AND consumed_before >= 0
    AND take_qty > 0
    AND consumed_after = consumed_before + take_qty
  )
);

CREATE TABLE instrument_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  source text NOT NULL,
  quote_asset text,
  base_asset text,
  tick_size numeric(24, 8),
  step_size numeric(24, 8),
  min_qty numeric(24, 8),
  min_notional numeric(24, 8),
  binance_status text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE liquidity_levels (
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  source text NOT NULL,
  book_side text NOT NULL,
  price numeric(24, 8) NOT NULL,
  quote_update_id text NOT NULL,
  displayed_qty numeric(24, 8) NOT NULL,
  consumed_qty numeric(24, 8) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, source, book_side, price),
  CONSTRAINT liquidity_levels_side_check CHECK (book_side IN ('BID', 'ASK')),
  CONSTRAINT liquidity_levels_qty_check CHECK (displayed_qty >= 0 AND consumed_qty >= 0),
  CONSTRAINT liquidity_levels_u_check CHECK (quote_update_id ~ '^[0-9]+$'),
  CONSTRAINT liquidity_levels_source_check CHECK (
    source IN ('binance-public:bookTicker', 'test-fixture')
  )
);

CREATE TABLE instrument_quote_cursors (
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  source text NOT NULL,
  last_update_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, source),
  CONSTRAINT instrument_quote_cursors_u_check CHECK (last_update_id ~ '^[0-9]+$'),
  CONSTRAINT instrument_quote_cursors_source_check CHECK (
    source IN ('binance-public:bookTicker', 'test-fixture')
  )
);

CREATE TRIGGER order_state_transitions_append_only
  BEFORE UPDATE OR DELETE ON order_state_transitions
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER executions_append_only
  BEFORE UPDATE OR DELETE ON executions
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER position_events_append_only
  BEFORE UPDATE OR DELETE ON position_events
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER simulation_cash_movements_append_only
  BEFORE UPDATE OR DELETE ON simulation_cash_movements
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER trading_commands_append_only
  BEFORE UPDATE OR DELETE ON trading_commands
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER trading_events_append_only
  BEFORE UPDATE OR DELETE ON trading_events
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER execution_audit_append_only
  BEFORE UPDATE OR DELETE ON execution_audit
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER risk_authorization_log_append_only
  BEFORE UPDATE OR DELETE ON risk_authorization_log
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER liquidity_allocations_append_only
  BEFORE UPDATE OR DELETE ON liquidity_allocations
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

CREATE TRIGGER instrument_rules_append_only
  BEFORE UPDATE OR DELETE ON instrument_rules
  FOR EACH ROW EXECUTE FUNCTION k2_reject_mutation();

INSERT INTO permissions (code, description) VALUES
  ('trading.read', 'Read the caller trading orders and positions'),
  ('trading.execute', 'Submit and cancel the caller orders'),
  ('trading.halt_instrument', 'Disable or halt an instrument for trading');

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'trading.read' FROM roles;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('TRADER', 'trading.execute'),
  ('ADMIN', 'trading.halt_instrument');
