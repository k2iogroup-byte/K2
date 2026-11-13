'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import { AuthChrome } from '../../../components/auth-chrome';
import { authFetch, errorMessage } from '../../../lib/auth-client';

type Enrollment = {
  otpauthUri: string;
  secret: string;
  recoveryCodes: string[];
};

export default function MfaPage(): ReactElement {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function enroll(): Promise<void> {
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await authFetch('/auth/mfa/enroll', { method: 'POST' });
    setPending(false);
    if (result.status === 200 && isEnrollment(result.body)) {
      setEnrollment(result.body);
      setMessage(
        'Add this key to an authenticator app, then enter a code. Recovery codes are shown once.',
      );
      return;
    }
    setError(errorMessage(result.body, 'Enrollment failed'));
  }

  async function verify(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authFetch('/auth/mfa/verify', { method: 'POST', body: { code } });
    setPending(false);
    if (result.status === 200) {
      setMessage('Multi-factor authentication is active.');
      setEnrollment(null);
      setCode('');
      return;
    }
    setError(errorMessage(result.body, 'The authentication code is incorrect'));
  }

  async function disable(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authFetch('/auth/mfa/disable', {
      method: 'POST',
      body: { password, totp: code },
    });
    setPending(false);
    if (result.status === 200) {
      setMessage('Multi-factor authentication was disabled.');
      return;
    }
    setError(errorMessage(result.body, 'MFA could not be disabled'));
  }

  return (
    <AuthChrome
      title="Multi-factor authentication"
      lede="Staff must enroll before staff tools unlock. Traders can enroll and can turn it off. Staff cannot turn it off."
    >
      <div className="form-actions">
        <button className="primary" type="button" onClick={() => void enroll()} disabled={pending}>
          {pending ? 'Working…' : 'Start enrollment'}
        </button>
        <a href="/account">Back to profile</a>
      </div>
      {enrollment ? (
        <section className="panel">
          <h2>Authenticator setup</h2>
          <p className="secret-block">{enrollment.otpauthUri}</p>
          <p>
            Secret: <span className="secret-block">{enrollment.secret}</span>
          </p>
          <h2>Recovery codes</h2>
          <ul>
            {enrollment.recoveryCodes.map((recovery) => (
              <li key={recovery} className="secret-block">
                {recovery}
              </li>
            ))}
          </ul>
          <form onSubmit={(event) => void verify(event)}>
            <label>
              Authentication code
              <input
                inputMode="numeric"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                required
              />
            </label>
            <div className="form-actions">
              <button className="primary" type="submit" disabled={pending}>
                Confirm enrollment
              </button>
            </div>
          </form>
        </section>
      ) : null}
      <section className="panel">
        <h2>Disable</h2>
        <form onSubmit={(event) => void disable(event)}>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              required
            />
          </label>
          <label>
            Authentication code
            <input
              inputMode="numeric"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              required
            />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={pending}>
              Disable MFA
            </button>
          </div>
        </form>
      </section>
      {message ? <p className="alert ok">{message}</p> : null}
      {error ? (
        <p className="alert bad" role="alert">
          {error}
        </p>
      ) : null}
    </AuthChrome>
  );
}

function isEnrollment(value: unknown): value is Enrollment {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'otpauthUri' in value &&
    typeof value.otpauthUri === 'string' &&
    'secret' in value &&
    typeof value.secret === 'string' &&
    'recoveryCodes' in value &&
    Array.isArray(value.recoveryCodes)
  );
}
