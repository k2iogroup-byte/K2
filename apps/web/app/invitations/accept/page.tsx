'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useEffect, useState } from 'react';

import { AuthChrome } from '../../../components/auth-chrome';
import { authFetch, errorMessage, readHashToken } from '../../../lib/auth-client';

export default function AcceptInvitationPage(): ReactElement {
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
    const result = await authFetch('/auth/invitations/accept', {
      method: 'POST',
      body: { token, password },
    });
    setPending(false);
    if (result.status === 201) {
      setMessage(
        'Invitation accepted. Sign in and enroll multi-factor authentication before using staff tools.',
      );
      return;
    }
    setError(errorMessage(result.body, 'This invitation is invalid or expired.'));
  }

  return (
    <AuthChrome
      title="Accept staff invitation"
      lede="Choose a password of at least 12 characters. Staff access stays locked until MFA enrollment is complete."
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        <label>
          Password
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
            {pending ? 'Accepting…' : 'Accept invitation'}
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
