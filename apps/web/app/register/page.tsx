'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useState } from 'react';

import { AuthChrome } from '../../components/auth-chrome';
import { authFetch, errorMessage } from '../../lib/auth-client';

const initial = {
  firstName: '',
  lastName: '',
  username: '',
  email: '',
  password: '',
  country: '',
  city: '',
  streetAddress: '',
  postalCode: '',
  phone: '',
};

export default function RegisterPage(): ReactElement {
  const [form, setForm] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function setField(key: keyof typeof initial, value: string): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await authFetch('/auth/register', {
      method: 'POST',
      body: form,
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
      lede="Registration creates a trader account. Every field is required. The account cannot purchase a challenge or use market data until the email address is verified. Passwords must be at least 12 characters."
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        <label>
          First name
          <input
            value={form.firstName}
            onChange={(event) => {
              setField('firstName', event.target.value);
            }}
            autoComplete="given-name"
            required
          />
        </label>
        <label>
          Last name
          <input
            value={form.lastName}
            onChange={(event) => {
              setField('lastName', event.target.value);
            }}
            autoComplete="family-name"
            required
          />
        </label>
        <label>
          Username
          <input
            value={form.username}
            onChange={(event) => {
              setField('username', event.target.value);
            }}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={form.email}
            onChange={(event) => {
              setField('email', event.target.value);
            }}
            autoComplete="email"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={form.password}
            onChange={(event) => {
              setField('password', event.target.value);
            }}
            required
          />
        </label>
        <label>
          Country
          <input
            value={form.country}
            onChange={(event) => {
              setField('country', event.target.value);
            }}
            autoComplete="country-name"
            required
          />
        </label>
        <label>
          City
          <input
            value={form.city}
            onChange={(event) => {
              setField('city', event.target.value);
            }}
            autoComplete="address-level2"
            required
          />
        </label>
        <label>
          Street address
          <input
            value={form.streetAddress}
            onChange={(event) => {
              setField('streetAddress', event.target.value);
            }}
            autoComplete="street-address"
            required
          />
        </label>
        <label>
          Postal code
          <input
            value={form.postalCode}
            onChange={(event) => {
              setField('postalCode', event.target.value);
            }}
            autoComplete="postal-code"
            required
          />
        </label>
        <label>
          Phone
          <input
            type="tel"
            value={form.phone}
            onChange={(event) => {
              setField('phone', event.target.value);
            }}
            autoComplete="tel"
            placeholder="+1 415 555 2671"
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
