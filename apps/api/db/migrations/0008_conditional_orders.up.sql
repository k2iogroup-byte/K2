-- Additive protection and stop orders. Does not change 0001–0007.
-- A pending entry stop is one working entry per account and instrument.
-- Firing a stop inserts a normal MARKET order through the existing path.

CREATE TABLE conditional_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES trading_accounts (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  position_id uuid REFERENCES positions (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  side text NOT NULL,
  trigger_price numeric(24, 8) NOT NULL,
  quantity numeric(24, 8),
  state text NOT NULL,
  resulting_order_id uuid REFERENCES orders (id) ON DELETE RESTRICT,
  idempotency_key text,
  client_order_id text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conditional_orders_kind_check CHECK (
    kind IN ('ENTRY_STOP', 'STOP_LOSS', 'TAKE_PROFIT')
  ),
  CONSTRAINT conditional_orders_side_check CHECK (side IN ('BUY', 'SELL')),
  CONSTRAINT conditional_orders_state_check CHECK (
    state IN ('PENDING', 'TRIGGERED', 'CANCELLED', 'EXPIRED')
  ),
  CONSTRAINT conditional_orders_price_check CHECK (trigger_price > 0),
  CONSTRAINT conditional_orders_quantity_check CHECK (
    (kind = 'ENTRY_STOP' AND quantity > 0)
    OR (kind <> 'ENTRY_STOP' AND (quantity IS NULL OR quantity > 0))
  )
);

CREATE UNIQUE INDEX conditional_orders_one_pending_entry_idx
  ON conditional_orders (account_id, instrument_id)
  WHERE kind = 'ENTRY_STOP' AND state = 'PENDING';

CREATE INDEX conditional_orders_pending_idx
  ON conditional_orders (instrument_id, kind)
  WHERE state = 'PENDING';

CREATE UNIQUE INDEX conditional_orders_idempotency_idx
  ON conditional_orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE position_protection (
  position_id uuid PRIMARY KEY REFERENCES positions (id) ON DELETE RESTRICT,
  stop_loss_price numeric(24, 8),
  take_profit_price numeric(24, 8),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_protection_stop_check CHECK (
    stop_loss_price IS NULL OR stop_loss_price > 0
  ),
  CONSTRAINT position_protection_take_check CHECK (
    take_profit_price IS NULL OR take_profit_price > 0
  )
);

CREATE FUNCTION k2_reject_buy_while_pending_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.side <> 'BUY' OR NEW.state = 'REJECTED' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM conditional_orders AS pending_entry
    WHERE pending_entry.account_id = NEW.account_id
      AND pending_entry.instrument_id = NEW.instrument_id
      AND pending_entry.kind = 'ENTRY_STOP'
      AND pending_entry.state = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'POSITION_ALREADY_OPEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_reject_buy_while_pending_entry
  BEFORE INSERT ON orders
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_buy_while_pending_entry();
