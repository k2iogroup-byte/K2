import { z } from 'zod';

export const databaseCheckSchema = z.strictObject({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int().nonnegative(),
  schemaVersion: z.string().nullable(),
});

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'degraded']),
  service: z.string().min(1),
  version: z.string().min(1),
  environment: z.enum(['development', 'staging', 'production']),
  checks: z.strictObject({
    database: databaseCheckSchema,
  }),
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type DatabaseCheck = z.infer<typeof databaseCheckSchema>;
