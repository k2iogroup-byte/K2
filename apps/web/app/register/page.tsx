'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import { AuthChrome } from '../../components/auth-chrome';
import { authFetch, errorMessage } from '../../lib/auth-client';

export default function RegisterPage(): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await authFetch('/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    setPending(false);
    if (result.status === 202) {
      setMessage('If the address can be registered, a verification message has been requested.');
      return;
    }
    setError(errorMessage(result.body, 'Registration failed'));
  }

  return (
    <AuthChrome
      title="Create account"
      lede="Registration creates a trader account. Passwords must be at least 12 characters. Role and status cannot be chosen here."
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
          <button className="primary" type="submit" disabled={pending}>
            {pending ? 'Creating account…' : 'Create account'}
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
