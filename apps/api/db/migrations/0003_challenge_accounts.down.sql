DROP TRIGGER IF EXISTS catalogue_commands_append_only ON catalogue_commands;
DROP TRIGGER IF EXISTS challenge_audit_events_append_only ON challenge_audit_events;
DROP TRIGGER IF EXISTS account_state_transitions_append_only ON account_state_transitions;
DROP TRIGGER IF EXISTS purchase_evidence_append_only ON purchase_evidence_references;
DROP TRIGGER IF EXISTS rule_parameters_append_only ON rule_parameters;
DROP TRIGGER IF EXISTS rule_set_versions_append_only ON rule_set_versions;
DROP TRIGGER IF EXISTS product_activation_events_append_only ON product_activation_events;
DROP TRIGGER IF EXISTS trading_accounts_guard ON trading_accounts;
DROP TRIGGER IF EXISTS product_price_versions_immutable ON product_price_versions;
DROP TRIGGER IF EXISTS challenge_products_guard ON challenge_products;

DROP FUNCTION IF EXISTS trading_accounts_guard();
DROP FUNCTION IF EXISTS product_price_versions_immutable();
DROP FUNCTION IF EXISTS challenge_products_guard();

DROP TABLE IF EXISTS catalogue_commands;
DROP TABLE IF EXISTS challenge_audit_events;
DROP TABLE IF EXISTS account_state_transitions;
DROP TABLE IF EXISTS trading_accounts;
DROP TABLE IF EXISTS purchase_evidence_references;
DROP TABLE IF EXISTS rule_parameters;
DROP TABLE IF EXISTS rule_set_versions;
DROP TABLE IF EXISTS rule_sets;
DROP TABLE IF EXISTS product_activation_events;
DROP TABLE IF EXISTS product_price_versions;
DROP TABLE IF EXISTS challenge_products;

DROP FUNCTION IF EXISTS k2_reject_mutation();

DELETE FROM role_permissions
WHERE permission_code IN ('accounts.read', 'accounts.transition', 'catalogue.manage');

DELETE FROM permissions
WHERE code IN ('accounts.read', 'accounts.transition', 'catalogue.manage');
