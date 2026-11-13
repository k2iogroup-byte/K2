import type { AccountLifecycleState, StaffTransitionReason } from '@k2/shared';

export type TransitionDecision =
  { kind: 'allow' } | { kind: 'invalid' } | { kind: 'unresolved'; question: string };

const BLOCKED: Partial<Record<AccountLifecycleState, string>> = {
  ACTIVE: 'ACTIVATION_CONDITION',
  PASSED: 'OQ-003',
  FAILED: 'OQ-001',
  EXPIRED: 'OQ-004',
};

const TERMINAL = new Set<AccountLifecycleState>(['PASSED', 'FAILED', 'EXPIRED', 'CLOSED']);

/**
 * Administrative transitions only. This function does not read rule parameters and
 * does not decide a pass, fail, expiry, or activation.
 */
export function decideStaffTransition(
  current: AccountLifecycleState,
  requested: AccountLifecycleState,
  reasonCode: StaffTransitionReason,
  resumeTarget: AccountLifecycleState | null,
): TransitionDecision {
  if (requested === current) return { kind: 'invalid' };
  if (reasonCode === 'STAFF_RESUME') {
    if (resumeTarget === null || requested !== resumeTarget) return { kind: 'invalid' };
    if (current !== 'SUSPENDED' && current !== 'UNDER_REVIEW') return { kind: 'invalid' };
    if (TERMINAL.has(resumeTarget)) return { kind: 'invalid' };
    return { kind: 'allow' };
  }
  const question = BLOCKED[requested];
  if (question !== undefined) return { kind: 'unresolved', question };
  if (TERMINAL.has(current)) return { kind: 'invalid' };
  if (
    reasonCode === 'STAFF_SUSPEND' &&
    requested === 'SUSPENDED' &&
    (current === 'PROVISIONED' || current === 'ACTIVE' || current === 'UNDER_REVIEW')
  ) {
    return { kind: 'allow' };
  }
  if (
    reasonCode === 'STAFF_REVIEW' &&
    requested === 'UNDER_REVIEW' &&
    (current === 'PROVISIONED' || current === 'ACTIVE' || current === 'SUSPENDED')
  ) {
    return { kind: 'allow' };
  }
  if (
    reasonCode === 'STAFF_CLOSE' &&
    requested === 'CLOSED' &&
    (current === 'PROVISIONED' ||
      current === 'ACTIVE' ||
      current === 'SUSPENDED' ||
      current === 'UNDER_REVIEW')
  ) {
    return { kind: 'allow' };
  }
  return { kind: 'invalid' };
}
