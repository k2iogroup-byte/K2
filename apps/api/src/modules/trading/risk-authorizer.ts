import { randomUUID } from 'node:crypto';

export type RiskAuthorizationRequest = {
  accountId: string;
  instrumentId: string;
  side: 'BUY' | 'SELL';
  quantity: string;
};

export type RiskDecision = {
  decision: 'APPROVE' | 'REJECT';
  decisionId: string;
  reasonCode: string;
  mode: 'FAIL_CLOSED' | 'TEST_DOUBLE' | 'RISK_REDUCING';
};

export interface RiskAuthorizer {
  authorize(request: RiskAuthorizationRequest): Promise<RiskDecision>;
}

export interface SessionCalendar {
  equitySessionOpen(at: Date): boolean;
}

/** Production authorizer. No approving adapter ships here. */
export class FailClosedRiskAuthorizer implements RiskAuthorizer {
  authorize(): Promise<RiskDecision> {
    return Promise.resolve({
      decision: 'REJECT',
      decisionId: randomUUID(),
      reasonCode: 'TEMPORARILY_UNAVAILABLE',
      mode: 'FAIL_CLOSED',
    });
  }
}

/** Equities stay closed until a calendar source is configured. */
export class ClosedEquityCalendar implements SessionCalendar {
  equitySessionOpen(): boolean {
    return false;
  }
}
