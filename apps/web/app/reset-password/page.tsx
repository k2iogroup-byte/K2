'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useEffect, useState } from 'react';

import { AuthChrome } from '../../components/auth-chrome';
import { authFetch, errorMessage, readHashToken } from '../../lib/auth-client';

export default function ResetPasswordPage(): ReactElement {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setToken(readHashToken());
  }, []);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authFetch('/auth/password/reset', {
      method: 'POST',
      body: { token, password },
    });
    setPending(false);
    if (result.status === 200) {
      setMessage('Password updated. Sign in with the new password.');
      return;
    }
    setError(errorMessage(result.body, 'This reset link is invalid or expired.'));
  }

  return (
    <AuthChrome
      title="Choose a new password"
      lede="The reset link works once. Existing sessions are signed out."
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            required
          />
        </label>
        <div className="form-actions">
          <button className="primary" type="submit" disabled={pending || token === ''}>
            {pending ? 'Updating…' : 'Update password'}
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
