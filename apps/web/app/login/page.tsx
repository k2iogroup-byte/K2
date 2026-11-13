'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import { AuthChrome } from '../../components/auth-chrome';
import { authFetch, errorMessage } from '../../lib/auth-client';

export default function LoginPage(): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    const result = mfaRequired
      ? await authFetch('/auth/mfa/verify', { method: 'POST', body: { code } })
      : await authFetch('/auth/login', { method: 'POST', body: { email, password } });
    setPending(false);
    if (result.status === 200) {
      const body = result.body;
      const required =
        typeof body === 'object' &&
        body !== null &&
        'mfaRequired' in body &&
        body.mfaRequired === true;
      if (required) {
        setMfaRequired(true);
        setMessage('Enter the authentication code from your authenticator app.');
        return;
      }
      window.location.assign('/account');
      return;
    }
    setError(errorMessage(result.body, 'Sign-in failed'));
  }

  return (
    <AuthChrome
      title="Sign in"
      lede="Use the email and password for your K2 Group account. Staff accounts continue to an authentication code."
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        {mfaRequired ? (
          <label>
            Authentication code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              required
            />
          </label>
        ) : (
          <>
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                required
              />
            </label>
          </>
        )}
        <div className="form-actions">
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
      {message ? <p className="alert ok">{message}</p> : null}
      {error ? (
        <p className="alert bad" role="alert">
          {error}
        </p>
      ) : null}
    </AuthChrome>
  );
}
