-- Correction for Modules 02–04.
-- Does not alter 0001–0004. Public registration fields are nullable so existing
-- staff rows stay valid. A public registration must set every field together.
-- external_identities stores a provider subject, never an email address.
-- No application path inserts into that table in this correction.

ALTER TABLE users
  ADD COLUMN first_name text,
  ADD COLUMN last_name text,
  ADD COLUMN username text,
  ADD COLUMN country text,
  ADD COLUMN city text,
  ADD COLUMN street_address text,
  ADD COLUMN postal_code text,
  ADD COLUMN phone_e164 text;

ALTER TABLE users
  ADD CONSTRAINT users_username_unique UNIQUE (username),
  ADD CONSTRAINT users_username_format CHECK (
    username IS NULL OR username ~ '^[a-z0-9]([a-z0-9._-]{1,30}[a-z0-9])$'
  ),
  ADD CONSTRAINT users_first_name_length CHECK (
    first_name IS NULL OR char_length(first_name) BETWEEN 1 AND 80
  ),
  ADD CONSTRAINT users_last_name_length CHECK (
    last_name IS NULL OR char_length(last_name) BETWEEN 1 AND 80
  ),
  ADD CONSTRAINT users_country_length CHECK (
    country IS NULL OR char_length(country) BETWEEN 2 AND 56
  ),
  ADD CONSTRAINT users_city_length CHECK (city IS NULL OR char_length(city) BETWEEN 1 AND 80),
  ADD CONSTRAINT users_street_length CHECK (
    street_address IS NULL OR char_length(street_address) BETWEEN 1 AND 120
  ),
  ADD CONSTRAINT users_postal_length CHECK (
    postal_code IS NULL OR char_length(postal_code) BETWEEN 1 AND 16
  ),
  ADD CONSTRAINT users_phone_e164_check CHECK (
    phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  ),
  ADD CONSTRAINT users_registration_fields_check CHECK (
    (
      first_name IS NULL
      AND last_name IS NULL
      AND username IS NULL
      AND country IS NULL
      AND city IS NULL
      AND street_address IS NULL
      AND postal_code IS NULL
      AND phone_e164 IS NULL
    )
    OR (
      first_name IS NOT NULL
      AND last_name IS NOT NULL
      AND username IS NOT NULL
      AND country IS NOT NULL
      AND city IS NOT NULL
      AND street_address IS NOT NULL
      AND postal_code IS NOT NULL
      AND phone_e164 IS NOT NULL
    )
  );

CREATE TABLE external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_subject text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_identities_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT external_identities_subject_check CHECK (
    char_length(provider_subject) BETWEEN 1 AND 255
    AND position('@' IN provider_subject) = 0
  ),
  CONSTRAINT external_identities_provider_subject_unique UNIQUE (provider, provider_subject),
  CONSTRAINT external_identities_user_provider_unique UNIQUE (user_id, provider)
);

COMMENT ON TABLE external_identities IS
  'Future provider subjects only. Do not insert a row because an email address matches. No linker is implemented.';

CREATE TABLE rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  hit_count integer NOT NULL,
  reset_at timestamptz NOT NULL,
  CONSTRAINT rate_limit_buckets_count_check CHECK (hit_count >= 0),
  CONSTRAINT rate_limit_buckets_key_length CHECK (char_length(bucket_key) BETWEEN 1 AND 200)
);

CREATE TABLE rate_limit_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT rate_limit_failures_key_length CHECK (char_length(bucket_key) BETWEEN 1 AND 200)
);

CREATE INDEX rate_limit_failures_key_time_idx
  ON rate_limit_failures (bucket_key, occurred_at);

INSERT INTO permissions (code, description) VALUES
  (
    'staff.users.sensitive.read',
    'Read another user phone number and postal address'
  );

DELETE FROM role_permissions
WHERE permission_code = 'staff.users.read'
  AND role_code IN ('FINANCE', 'RISK', 'TRADING_REVIEW', 'MANAGEMENT', 'COMPLIANCE');

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('ADMIN', 'staff.users.sensitive.read');
