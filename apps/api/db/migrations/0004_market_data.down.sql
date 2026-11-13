DELETE FROM role_permissions
WHERE permission_code IN ('market_data.read', 'market_data.health', 'market_data.manage');

DELETE FROM permissions
WHERE code IN ('market_data.read', 'market_data.health', 'market_data.manage');

DROP TABLE IF EXISTS feed_status_events;
DROP TABLE IF EXISTS bars;
DROP TABLE IF EXISTS quote_snapshots;
DROP TABLE IF EXISTS instruments;
