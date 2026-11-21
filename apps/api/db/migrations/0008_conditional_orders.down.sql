DROP TRIGGER IF EXISTS orders_reject_buy_while_pending_entry ON orders;
DROP FUNCTION IF EXISTS k2_reject_buy_while_pending_entry();
DROP TABLE IF EXISTS position_protection;
DROP TABLE IF EXISTS conditional_orders;
