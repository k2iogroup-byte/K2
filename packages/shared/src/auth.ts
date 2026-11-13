import { z } from 'zod';

export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export const ROLE_CODES = [
  'TRADER',
  'SUPPORT',
  'RISK',
  'TRADING_REVIEW',
  'MANAGEMENT',
  'FINANCE',
  'COMPLIANCE',
  'ADMIN',
] as const;
export const STAFF_ROLE_CODES = [
  'SUPPORT',
  'RISK',
  'TRADING_REVIEW',
  'MANAGEMENT',
  'FINANCE',
  'COMPLIANCE',
  'ADMIN',
] as const;

export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);
export const roleCodeSchema = z.enum(ROLE_CODES);
export const staffRoleSchema = z.enum(STAFF_ROLE_CODES);

export const emailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email());
export const passwordSchema = z.string().min(12).max(128);
const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const totpSchema = z.string().regex(/^\d{6}$/);
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} .,'-]+$/u);

export const registerRequestSchema = z
  .strictObject({
    email: emailSchema,
    password: passwordSchema,
  })
  .superRefine((value, context) => {
    if (value.password.toLowerCase() === value.email) {
      context.addIssue({ code: 'custom', path: ['password'], message: 'Invalid value' });
    }
  });

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const emailRequestSchema = z.strictObject({
  email: emailSchema,
});

export const tokenRequestSchema = z.strictObject({
  token: opaqueTokenSchema,
});

export const resetPasswordRequestSchema = z
  .strictObject({
    token: opaqueTokenSchema,
    password: passwordSchema,
  })
  .superRefine((value, context) => {
    if (value.password.toLowerCase() === value.token.toLowerCase()) {
      context.addIssue({ code: 'custom', path: ['password'], message: 'Invalid value' });
    }
  });

export const changePasswordRequestSchema = z
  .strictObject({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
    totp: totpSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.newPassword === value.currentPassword) {
      context.addIssue({ code: 'custom', path: ['newPassword'], message: 'Invalid value' });
    }
  });

export const profilePatchSchema = z.strictObject({
  displayName: displayNameSchema.nullable(),
});

export const mfaCodeRequestSchema = z.strictObject({
  code: totpSchema,
});

export const recoveryCodeRequestSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase().replace(/-/g, ''))
    .pipe(z.string().regex(/^[A-Z2-9]{12}$/)),
});

export const mfaDisableRequestSchema = z.strictObject({
  password: z.string().min(1).max(128),
  totp: totpSchema,
});

export const reauthSchema = z.strictObject({
  password: z.string().min(1).max(128),
  totp: totpSchema,
});

export const invitationRequestSchema = reauthSchema.extend({
  email: emailSchema,
  role: staffRoleSchema,
});

export const acceptInvitationRequestSchema = z
  .strictObject({
    token: opaqueTokenSchema,
    password: passwordSchema,
  })
  .superRefine((value, context) => {
    if (value.password.toLowerCase() === value.token.toLowerCase()) {
      context.addIssue({ code: 'custom', path: ['password'], message: 'Invalid value' });
    }
  });

export const roleAssignmentRequestSchema = reauthSchema
  .extend({
    roles: z.array(roleCodeSchema).min(1).max(ROLE_CODES.length),
  })
  .superRefine((value, context) => {
    if (new Set(value.roles).size !== value.roles.length) {
      context.addIssue({ code: 'custom', path: ['roles'], message: 'Invalid value' });
    }
  });

export const statusChangeRequestSchema = reauthSchema.extend({
  status: accountStatusSchema,
});

export const acceptedResponseSchema = z.strictObject({
  status: z.literal('accepted'),
});

export const loginResponseSchema = z.strictObject({
  status: z.enum(['authenticated', 'mfa_required']),
  mfaRequired: z.boolean(),
});

export const verifiedResponseSchema = z.strictObject({
  status: z.literal('verified'),
});

export const loggedOutResponseSchema = z.strictObject({
  status: z.literal('logged_out'),
});

export const passwordResultResponseSchema = z.strictObject({
  status: z.enum(['reset', 'changed']),
  notification: z.enum(['sent', 'unavailable']),
});

export const profileResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string().nullable(),
  status: accountStatusSchema,
  emailVerified: z.boolean(),
  emailVerifiedAt: z.string().nullable(),
  createdAt: z.string(),
  roles: z.array(roleCodeSchema),
  mfaEnrolled: z.boolean(),
});

export const authMeResponseSchema = z.strictObject({
  profile: profileResponseSchema,
  staff: z.boolean(),
  mfaSatisfied: z.boolean(),
  permissions: z.array(z.string()),
  session: z.strictObject({
    id: z.uuid(),
    expiresAt: z.string(),
  }),
});

export const sessionListResponseSchema = z.strictObject({
  sessions: z.array(
    z.strictObject({
      id: z.uuid(),
      createdAt: z.string(),
      lastSeenAt: z.string(),
      expiresAt: z.string(),
      ip: z.string().nullable(),
      userAgent: z.string().nullable(),
      current: z.boolean(),
    }),
  ),
});

export const revokedResponseSchema = z.strictObject({
  status: z.literal('revoked'),
  revokedCount: z.number().int().nonnegative(),
});

export const mfaEnrollResponseSchema = z.strictObject({
  factorId: z.uuid(),
  otpauthUri: z.string().min(1),
  secret: z.string().min(1),
  recoveryCodes: z.array(z.string().min(1)),
});

export const mfaVerifiedResponseSchema = z.strictObject({
  status: z.literal('verified'),
});

export const staffUserResponseSchema = profileResponseSchema;

export const invitedResponseSchema = z.strictObject({
  status: z.literal('invited'),
});

export const rolesUpdatedResponseSchema = z.strictObject({
  status: z.literal('updated'),
  roles: z.array(roleCodeSchema),
});

export const statusUpdatedResponseSchema = z.strictObject({
  status: z.literal('updated'),
  accountStatus: accountStatusSchema,
});

export const auditListResponseSchema = z.strictObject({
  events: z.array(
    z.strictObject({
      id: z.uuid(),
      eventType: z.string(),
      actorUserId: z.uuid().nullable(),
      targetUserId: z.uuid().nullable(),
      ip: z.string().nullable(),
      createdAt: z.string(),
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
  ),
});

export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type RoleCode = z.infer<typeof roleCodeSchema>;
export type StaffRoleCode = z.infer<typeof staffRoleSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
