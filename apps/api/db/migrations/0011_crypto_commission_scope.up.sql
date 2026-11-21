-- Founder decision 2026-11-21: the 0.5% opening commission applies to crypto.
-- Inserts only. Existing tables and constraints are unchanged.

INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
SELECT version.id, 'CRYPTO', 'D-CRYPTO-USDT-20261121'
FROM rule_set_versions AS version
WHERE NOT EXISTS (
  SELECT 1
  FROM commission_market_scopes AS scope
  WHERE scope.rule_set_version_id = version.id
    AND scope.market = 'CRYPTO'
);
