const PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:password|passwd|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi,
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
  'databaseUrl',
  'connectionString',
  'authorization',
  'cookie',
  '*.password',
  '*.databaseUrl',
  '*.connectionString',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
] as const;
