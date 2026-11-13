DELETE FROM role_permissions
WHERE permission_code = 'staff.users.sensitive.read';

DELETE FROM permissions
WHERE code = 'staff.users.sensitive.read';

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'staff.users.read'
FROM roles
WHERE code IN ('FINANCE', 'RISK', 'TRADING_REVIEW', 'MANAGEMENT', 'COMPLIANCE')
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS external_identities;
DROP TABLE IF EXISTS rate_limit_failures;
DROP TABLE IF EXISTS rate_limit_buckets;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_registration_fields_check,
  DROP CONSTRAINT IF EXISTS users_phone_e164_check,
  DROP CONSTRAINT IF EXISTS users_postal_length,
  DROP CONSTRAINT IF EXISTS users_street_length,
  DROP CONSTRAINT IF EXISTS users_city_length,
  DROP CONSTRAINT IF EXISTS users_country_length,
  DROP CONSTRAINT IF EXISTS users_last_name_length,
  DROP CONSTRAINT IF EXISTS users_first_name_length,
  DROP CONSTRAINT IF EXISTS users_username_format,
  DROP CONSTRAINT IF EXISTS users_username_unique;

ALTER TABLE users
  DROP COLUMN IF EXISTS phone_e164,
  DROP COLUMN IF EXISTS postal_code,
  DROP COLUMN IF EXISTS street_address,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS username,
  DROP COLUMN IF EXISTS last_name,
  DROP COLUMN IF EXISTS first_name;
