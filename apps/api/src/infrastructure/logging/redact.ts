const PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:password|passwd|secret|api[_-]?key|authorization|token|totp)\b\s*[:=]\s*[^\s,;]+/gi,
  /\bk2_(?:session|csrf|mfa)=[^;\s]+/gi,
];

export function redactSensitiveText(text: string): string {
  let output = text;
  for (const pattern of PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

export const REDACT_CENSOR = '[REDACTED]';

export const REDACT_PATHS = [
  'password',
  'phone',
  'phoneE164',
  'streetAddress',
  'postalCode',
  'currentPassword',
  'newPassword',
  'token',
  'secret',
  'csrf',
  'csrfToken',
  'recoveryCode',
  'recoveryCodes',
  'otpauthUri',
  'mfaEncryptionKey',
  'databaseUrl',
  'connectionString',
  'authorization',
  'cookie',
  '*.password',
  '*.phone',
  '*.phoneE164',
  '*.streetAddress',
  '*.postalCode',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.secret',
  '*.csrf',
  '*.csrfToken',
  '*.recoveryCode',
  '*.recoveryCodes',
  '*.otpauthUri',
  '*.databaseUrl',
  '*.connectionString',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
] as const;
