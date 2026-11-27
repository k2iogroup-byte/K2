import { describe, expect, it } from 'vitest';

import { stageRules } from '../../src/modules/risk/stage.js';

describe('stage rules', () => {
  it('uses 8 percent and 30 days for stage 1, and 5 percent and 60 days for stage 2', () => {
    expect(stageRules('STAGE_1')).toEqual({ factor: '1.0800', limitDays: 30 });
    expect(stageRules('STAGE_2')).toEqual({ factor: '1.0500', limitDays: 60 });
  });
});
