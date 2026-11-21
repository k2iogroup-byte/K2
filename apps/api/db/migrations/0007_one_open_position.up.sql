-- One working entry BUY per account and instrument.
-- Does not edit 0006. A position row remains unique per account and instrument.
-- Interim rule until scaling-in (OD-02): a new BUY is rejected while quantity or
-- reserved sell is still positive, or while a SELL is still working.

CREATE UNIQUE INDEX orders_one_working_buy_idx
  ON orders (account_id, instrument_id)
  WHERE side = 'BUY' AND state IN ('OPEN', 'PARTIALLY_FILLED');

CREATE FUNCTION k2_reject_position_increasing_buy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.side <> 'BUY' OR NEW.state = 'REJECTED' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM positions AS position
    WHERE position.account_id = NEW.account_id
      AND position.instrument_id = NEW.instrument_id
      AND (position.quantity > 0 OR position.reserved_sell > 0)
  ) THEN
    RAISE EXCEPTION 'POSITION_ALREADY_OPEN' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM orders AS working_sell
    WHERE working_sell.account_id = NEW.account_id
      AND working_sell.instrument_id = NEW.instrument_id
      AND working_sell.side = 'SELL'
      AND working_sell.state IN ('OPEN', 'PARTIALLY_FILLED')
      AND working_sell.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'POSITION_ALREADY_OPEN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_reject_position_increasing_buy
  BEFORE INSERT ON orders
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_position_increasing_buy();
