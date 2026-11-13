import type { ZodType } from 'zod';

import { AppError } from './errors.js';

type FailedParse = {
  success: false;
  error: { issues: readonly { path: PropertyKey[] }[] };
};

type ParseResult<T> = { success: true; data: T } | FailedParse;

export function parseWithSchema<T>(
  schema: ZodType<T> & { safeParse(value: unknown): ParseResult<T> },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(
    'VALIDATION_ERROR',
    400,
    'Request validation failed',
    parsed.error.issues.map((issue) => ({
      path:
        issue.path.length === 0
          ? 'request'
          : issue.path.map((segment) => String(segment)).join('.'),
      message: 'Invalid value',
    })),
  );
}
