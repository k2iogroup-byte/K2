'use client';

import { type HealthResponse, healthResponseSchema } from '@k2/shared';
import { type ReactElement, useCallback, useEffect, useState } from 'react';

import { readApiBaseUrl } from '../lib/api-base-url';

type PanelState =
  | { kind: 'loading' }
  | { kind: 'misconfigured'; reason: string }
  | { kind: 'unreachable' }
  | { kind: 'invalid' }
  | { kind: 'ready'; health: HealthResponse };

export function HealthPanel(): ReactElement {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const base = readApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL);
    if (!base.ok) {
      setState({ kind: 'misconfigured', reason: base.reason });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const response = await fetch(`${base.baseUrl}/health`, { cache: 'no-store', signal });
      const payload: unknown = await response.json();
      const parsed = healthResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setState({ kind: 'invalid' });
        return;
      }
      setState({ kind: 'ready', health: parsed.data });
    } catch {
      if (signal?.aborted) return;
      setState({ kind: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  return (
    <section className="panel" aria-labelledby="health-heading">
      <div className="panel-heading">
        <h2 id="health-heading">API health</h2>
        <button type="button" onClick={() => void load()}>
          Check again
        </button>
      </div>
      <div role="status" aria-live="polite">
        {renderState(state)}
      </div>
    </section>
  );
}

function renderState(state: PanelState): ReactElement {
  if (state.kind === 'loading') return <p>Checking the API.</p>;
  if (state.kind === 'misconfigured') return <p>Frontend configuration: {state.reason}.</p>;
  if (state.kind === 'unreachable') return <p>The API is unreachable from this browser.</p>;
  if (state.kind === 'invalid')
    return <p>The API returned a response this page does not understand.</p>;
  const health = state.health;
  const label = health.status === 'ok' ? 'Operational' : 'Degraded';
  return (
    <dl>
      <div>
        <dt>Status</dt>
        <dd className={health.status === 'ok' ? 'ok' : 'bad'}>{label}</dd>
      </div>
      <div>
        <dt>Database</dt>
        <dd>{health.checks.database.status === 'up' ? 'Up' : 'Down'}</dd>
      </div>
      <div>
        <dt>Schema</dt>
        <dd>{health.checks.database.schemaVersion ?? 'Not migrated'}</dd>
      </div>
      <div>
        <dt>Environment</dt>
        <dd>{health.environment}</dd>
      </div>
      <div>
        <dt>Checked</dt>
        <dd>{health.timestamp}</dd>
      </div>
    </dl>
  );
}
