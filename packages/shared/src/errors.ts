import { z } from 'zod';

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  'AUTHENTICATION_FAILED',
  'ACCOUNT_UNAVAILABLE',
  'FORBIDDEN',
  'MFA_REQUIRED',
  'MFA_ENROLLMENT_REQUIRED',
  'RATE_LIMITED',
  'CONFLICT',
  'EMAIL_DELIVERY_UNAVAILABLE',
  'CSRF_FAILED',
  'UNRESOLVED_RULE',
  'DEPENDENCY_UNAVAILABLE',
] as const;

export const apiErrorDetailSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
    details: z.array(apiErrorDetailSchema).optional(),
  }),
});

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;
