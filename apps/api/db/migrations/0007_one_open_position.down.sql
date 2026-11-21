DROP TRIGGER IF EXISTS orders_reject_position_increasing_buy ON orders;
DROP FUNCTION IF EXISTS k2_reject_position_increasing_buy();
DROP INDEX IF EXISTS orders_one_working_buy_idx;
