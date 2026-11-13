-- Module 01 infrastructure marker.
-- This is not a business table. Accounts, orders, ledger entries, and other
-- domain tables are intentionally absent until their modules are specified.

CREATE TABLE foundation_schema_info (
  id smallint PRIMARY KEY,
  schema_version text NOT NULL,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT foundation_schema_info_singleton CHECK (id = 1)
);

INSERT INTO foundation_schema_info (id, schema_version, description)
VALUES (
  1,
  '0001',
  'Module 01 infrastructure marker. Not a business table.'
);
