import { describe, expect, it } from 'vitest';

import * as lifecycle from '../../src/modules/accounts/lifecycle.js';

describe('challenge account transitions', () => {
  it('allows administrative holds and refuses unresolved outcomes', () => {
    expect(
      lifecycle.decideStaffTransition('PROVISIONED', 'SUSPENDED', 'STAFF_SUSPEND', null),
    ).toEqual({ kind: 'allow' });
    expect(
      lifecycle.decideStaffTransition('PROVISIONED', 'UNDER_REVIEW', 'STAFF_REVIEW', null),
    ).toEqual({ kind: 'allow' });
    expect(lifecycle.decideStaffTransition('PROVISIONED', 'CLOSED', 'STAFF_CLOSE', null)).toEqual({
      kind: 'allow',
    });
    expect(
      lifecycle.decideStaffTransition('SUSPENDED', 'PROVISIONED', 'STAFF_RESUME', 'PROVISIONED'),
    ).toEqual({
      kind: 'allow',
    });
    expect(lifecycle.decideStaffTransition('PROVISIONED', 'ACTIVE', 'STAFF_CLOSE', null)).toEqual({
      kind: 'unresolved',
      question: 'ACTIVATION_CONDITION',
    });
    expect(lifecycle.decideStaffTransition('PROVISIONED', 'PASSED', 'STAFF_CLOSE', null)).toEqual({
      kind: 'unresolved',
      question: 'OQ-003',
    });
    expect(lifecycle.decideStaffTransition('PROVISIONED', 'FAILED', 'STAFF_SUSPEND', null)).toEqual(
      {
        kind: 'unresolved',
        question: 'OQ-001',
      },
    );
    expect(lifecycle.decideStaffTransition('ACTIVE', 'EXPIRED', 'STAFF_CLOSE', null)).toEqual({
      kind: 'unresolved',
      question: 'OQ-004',
    });
    expect(lifecycle.decideStaffTransition('CLOSED', 'SUSPENDED', 'STAFF_SUSPEND', null)).toEqual({
      kind: 'invalid',
    });
    expect(
      lifecycle.decideStaffTransition('SUSPENDED', 'SUSPENDED', 'STAFF_SUSPEND', null),
    ).toEqual({
      kind: 'invalid',
    });
    expect(Object.keys(lifecycle)).toEqual(['decideStaffTransition']);
  });
});
