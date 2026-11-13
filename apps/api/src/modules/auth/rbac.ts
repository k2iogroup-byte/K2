import type { RoleCode } from '@k2/shared';

import { AppError } from '../../infrastructure/http/errors.js';

export const PERMISSIONS = {
  profileRead: 'profile.read',
  profileUpdate: 'profile.update',
  sessionList: 'session.list',
  sessionRevoke: 'session.revoke',
  passwordChange: 'password.change',
  mfaEnroll: 'mfa.enroll',
  staffUsersRead: 'staff.users.read',
  staffUsersSensitiveRead: 'staff.users.sensitive.read',
  staffInvite: 'staff.invite',
  staffRolesAssign: 'staff.roles.assign',
  staffStatusChange: 'staff.status.change',
  staffMfaReset: 'staff.mfa.reset',
  auditRead: 'audit.read',
  accountsRead: 'accounts.read',
  accountsTransition: 'accounts.transition',
  catalogueManage: 'catalogue.manage',
  marketDataRead: 'market_data.read',
  marketDataHealth: 'market_data.health',
  marketDataManage: 'market_data.manage',
} as const;

export type AuthContext = {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  emailVerifiedAt: string | null;
  createdAt: string;
  roles: readonly RoleCode[];
  permissions: ReadonlySet<string>;
  staff: boolean;
  mfaEnrolled: boolean;
  mfaSatisfied: boolean;
  csrfHash: string;
  expiresAt: string;
};

export function requirePermission(auth: AuthContext, permission: string): void {
  if (!auth.permissions.has(permission)) {
    throw new AppError('FORBIDDEN', 403, 'You do not have access to this action');
  }
}

export function requireStaffAccess(auth: AuthContext, permission: string): void {
  if (!auth.staff) {
    throw new AppError('FORBIDDEN', 403, 'You do not have access to this action');
  }
  requireVerifiedEmail(auth);
  if (!auth.mfaEnrolled) {
    throw new AppError(
      'MFA_ENROLLMENT_REQUIRED',
      403,
      'Enroll multi-factor authentication before using staff tools',
    );
  }
  if (!auth.mfaSatisfied) {
    throw new AppError('MFA_REQUIRED', 403, 'Staff multi-factor authentication is required');
  }
  requirePermission(auth, permission);
}

export function requireVerifiedEmail(auth: AuthContext): void {
  if (auth.emailVerifiedAt === null) {
    throw new AppError(
      'EMAIL_NOT_VERIFIED',
      403,
      'Verify your email before using this part of the account',
    );
  }
}
