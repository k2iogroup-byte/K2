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
  staffInvite: 'staff.invite',
  staffRolesAssign: 'staff.roles.assign',
  staffStatusChange: 'staff.status.change',
  staffMfaReset: 'staff.mfa.reset',
  auditRead: 'audit.read',
  accountsRead: 'accounts.read',
  accountsTransition: 'accounts.transition',
  catalogueManage: 'catalogue.manage',
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
