'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import { AuthChrome } from '../../components/auth-chrome';
import { authFetch, errorMessage, readHashToken } from '../../lib/auth-client';

export default function VerifyEmailPage(): ReactElement {
  const [message, setMessage] = useState('Checking the verification link…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = readHashToken();
    if (token === '') {
      setMessage('');
      setError('This verification link is invalid or expired.');
      return;
    }
    void authFetch('/auth/email/verify', { method: 'POST', body: { token } }).then((result) => {
      if (result.status === 200) {
        setMessage('Email verified. You can sign in.');
        setError(null);
        return;
      }
      setMessage('');
      setError(errorMessage(result.body, 'This verification link is invalid or expired.'));
    });
  }, []);

  return (
    <AuthChrome title="Verify email" lede="Email verification is separate from the account status.">
      {message ? <p className="alert ok">{message}</p> : null}
      {error ? (
        <p className="alert bad" role="alert">
          {error}
        </p>
      ) : null}
    </AuthChrome>
  );
}
