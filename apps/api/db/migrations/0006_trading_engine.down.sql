DELETE FROM role_permissions
WHERE permission_code IN ('trading.read', 'trading.execute', 'trading.halt_instrument');

DELETE FROM permissions
WHERE code IN ('trading.read', 'trading.execute', 'trading.halt_instrument');

DROP TABLE IF EXISTS instrument_quote_cursors;
DROP TABLE IF EXISTS liquidity_levels;
DROP TABLE IF EXISTS instrument_rules;
DROP TABLE IF EXISTS liquidity_allocations;
DROP TABLE IF EXISTS execution_model_versions;
DROP TABLE IF EXISTS commission_market_scopes;
DROP TABLE IF EXISTS ledger_outbox;
DROP TABLE IF EXISTS risk_authorization_log;
DROP TABLE IF EXISTS execution_audit;
DROP TABLE IF EXISTS trading_events;
DROP TABLE IF EXISTS trading_event_counters;
DROP TABLE IF EXISTS trading_commands;
DROP TABLE IF EXISTS simulation_cash_movements;
DROP TABLE IF EXISTS simulation_cash_projections;
DROP TABLE IF EXISTS position_events;
DROP TABLE IF EXISTS positions;
DROP TABLE IF EXISTS executions;
DROP TABLE IF EXISTS order_state_transitions;
DROP TABLE IF EXISTS orders;
DROP SEQUENCE IF EXISTS order_accept_sequence;

ALTER TABLE instruments
  DROP CONSTRAINT IF EXISTS instruments_quote_asset_check,
  DROP CONSTRAINT IF EXISTS instruments_trading_status_check;

ALTER TABLE instruments
  DROP COLUMN IF EXISTS quote_asset,
  DROP COLUMN IF EXISTS trading_status;
