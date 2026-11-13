'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import { AuthChrome } from '../../components/auth-chrome';
import { authFetch, errorMessage } from '../../lib/auth-client';

export default function ForgotPasswordPage(): ReactElement {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await authFetch('/auth/password/forgot', {
      method: 'POST',
      body: { email },
    });
    setPending(false);
    if (result.status === 202) {
      setMessage('If an eligible account exists, a reset message has been requested.');
      return;
    }
    setError(errorMessage(result.body, 'The reset request failed'));
  }

  return (
    <AuthChrome
      title="Reset password"
      lede="Request a one-time link. The response does not reveal whether an account exists."
    >
      <form onSubmit={(event) => void onSubmit(event)}>
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
        <div className="form-actions">
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'Requesting…' : 'Send reset link'}
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
