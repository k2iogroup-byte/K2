import type { ReactElement } from 'react';

import { HealthPanel } from '../components/health-panel';

export default function HomePage(): ReactElement {
  return (
    <main id="content">
      <p className="eyebrow">Proprietary trading firm</p>
      <h1>K2 Group</h1>
      <p className="lede">
        Technical foundation for the proprietary trading Challenge platform. This module does not
        provide accounts, payments, or trading.
      </p>
      <HealthPanel />
      <p className="footnote">
        Simulated-trading platform foundation. Not a broker and not a live market.
      </p>
    </main>
  );
}
