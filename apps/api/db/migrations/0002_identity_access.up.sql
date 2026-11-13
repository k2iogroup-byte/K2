-- Module 02 identity and access.
-- Does not alter 0001. Email verification is a timestamp, not an account status.
-- Account status is only ACTIVE, SUSPENDED, or CLOSED.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  CONSTRAINT users_display_name_length CHECK (
    display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 80
  )
);

CREATE TABLE credentials (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  password_hash text NOT NULL,
  algorithm text NOT NULL,
  parameters jsonb NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_algorithm_check CHECK (algorithm = 'argon2id')
);

CREATE TABLE roles (
  code text PRIMARY KEY,
  description text NOT NULL,
  is_staff boolean NOT NULL,
  CONSTRAINT roles_code_check CHECK (code = upper(code))
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_code text NOT NULL REFERENCES roles (code) ON DELETE RESTRICT,
  permission_code text NOT NULL REFERENCES permissions (code) ON DELETE RESTRICT,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role_code text NOT NULL REFERENCES roles (code) ON DELETE RESTRICT,
  granted_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  csrf_hash text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from_id uuid REFERENCES sessions (id) ON DELETE RESTRICT,
  ip text,
  user_agent text,
  mfa_verified_at timestamptz,
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_kind_check CHECK (kind IN ('full', 'mfa_pending')),
  CONSTRAINT sessions_hash_length CHECK (
    char_length(token_hash) = 64 AND char_length(csrf_hash) = 64
  )
);

CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_tokens_hash_unique UNIQUE (token_hash)
);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_hash_unique UNIQUE (token_hash)
);

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  factor_type text NOT NULL,
  secret_ciphertext text NOT NULL,
  secret_nonce text NOT NULL,
  confirmed_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_factors_type_check CHECK (factor_type = 'totp')
);

CREATE UNIQUE INDEX mfa_factors_one_live_idx ON mfa_factors (user_id) WHERE disabled_at IS NULL;

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  factor_id uuid NOT NULL REFERENCES mfa_factors (id) ON DELETE RESTRICT,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mfa_recovery_codes_hash_unique UNIQUE (code_hash)
);

CREATE TABLE staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role_code text NOT NULL REFERENCES roles (code) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  invited_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_invitations_hash_unique UNIQUE (token_hash),
  CONSTRAINT staff_invitations_email_lowercase CHECK (email = lower(email))
);

CREATE INDEX staff_invitations_email_idx ON staff_invitations (email);

CREATE TABLE authentication_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  target_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  ip text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX authentication_audit_events_created_idx
  ON authentication_audit_events (created_at DESC);

CREATE FUNCTION authentication_audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authentication_audit_events is append-only';
END;
$$;

CREATE TRIGGER authentication_audit_events_no_update
  BEFORE UPDATE OR DELETE ON authentication_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION authentication_audit_events_append_only();

INSERT INTO permissions (code, description) VALUES
  ('profile.read', 'Read the signed-in profile'),
  ('profile.update', 'Update permitted profile fields'),
  ('session.list', 'List the signed-in user sessions'),
  ('session.revoke', 'Revoke the signed-in user sessions'),
  ('password.change', 'Change the signed-in user password'),
  ('mfa.enroll', 'Manage the signed-in user MFA factor'),
  ('staff.users.read', 'Read another user profile for staff work'),
  ('staff.invite', 'Invite a staff account'),
  ('staff.roles.assign', 'Change a user role set'),
  ('staff.status.change', 'Suspend, close, or reactivate an account'),
  ('staff.mfa.reset', 'Reset another user MFA factor'),
  ('audit.read', 'Read authentication audit events');

INSERT INTO roles (code, description, is_staff) VALUES
  ('TRADER', 'Public trading customer', false),
  ('SUPPORT', 'Staff support operator', true),
  ('RISK', 'Staff risk operator', true),
  ('TRADING_REVIEW', 'Staff trading reviewer', true),
  ('MANAGEMENT', 'Staff management operator', true),
  ('FINANCE', 'Staff finance operator', true),
  ('COMPLIANCE', 'Staff compliance operator', true),
  ('ADMIN', 'Staff administrator', true);

INSERT INTO role_permissions (role_code, permission_code)
SELECT roles.code, permissions.code
FROM roles
CROSS JOIN (
  VALUES
    ('profile.read'),
    ('profile.update'),
    ('session.list'),
    ('session.revoke'),
    ('password.change'),
    ('mfa.enroll')
) AS permissions (code);

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'staff.users.read' FROM roles WHERE is_staff;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('COMPLIANCE', 'audit.read'),
  ('ADMIN', 'audit.read'),
  ('ADMIN', 'staff.invite'),
  ('ADMIN', 'staff.roles.assign'),
  ('ADMIN', 'staff.status.change'),
  ('ADMIN', 'staff.mfa.reset');
