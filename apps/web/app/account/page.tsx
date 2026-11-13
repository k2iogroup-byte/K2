'use client';

import type { ReactElement, SubmitEvent } from 'react';
import { useEffect, useState } from 'react';

import { AuthChrome } from '../../components/auth-chrome';
import { authFetch, errorMessage } from '../../lib/auth-client';

type Profile = {
  id: string;
  email: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  displayName: string | null;
  status: string;
  emailVerified: boolean;
  createdAt: string;
  roles: string[];
  mfaEnrolled: boolean;
};

type SessionRow = {
  id: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
};

type Me = {
  profile: Profile;
  staff: boolean;
  mfaSatisfied: boolean;
  permissions: string[];
};

export default function AccountPage(): ReactElement {
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('SUPPORT');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    const meResult = await authFetch('/auth/me');
    if (meResult.status !== 200 || !isMe(meResult.body)) {
      setError('Sign in to view this page.');
      return;
    }
    setMe(meResult.body);
    setDisplayName(meResult.body.profile.displayName ?? '');
    const sessionsResult = await authFetch('/auth/sessions');
    if (sessionsResult.status === 200 && isSessionList(sessionsResult.body)) {
      setSessions(sessionsResult.body.sessions);
    }
  }

  async function saveProfile(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await authFetch('/users/me', {
      method: 'PATCH',
      body: { displayName: displayName.trim() === '' ? null : displayName.trim() },
    });
    setPending(false);
    if (result.status === 200) {
      setMessage('Profile updated.');
      await load();
      return;
    }
    setError(errorMessage(result.body, 'Profile update failed'));
  }

  async function changePassword(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await authFetch('/auth/password/change', {
      method: 'POST',
      body: {
        currentPassword,
        newPassword,
        ...(totp === '' ? {} : { totp }),
      },
    });
    setPending(false);
    if (result.status === 200) {
      setMessage('Password changed. Other sessions were signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setTotp('');
      await load();
      return;
    }
    setError(errorMessage(result.body, 'Password change failed'));
  }

  async function revoke(id: string): Promise<void> {
    setError(null);
    const result = await authFetch(`/auth/sessions/${id}`, { method: 'DELETE' });
    if (result.status !== 200) {
      setError(errorMessage(result.body, 'Could not revoke that session'));
      return;
    }
    if (sessions.find((session) => session.id === id)?.current) {
      window.location.assign('/login');
      return;
    }
    await load();
  }

  async function revokeOthers(): Promise<void> {
    setError(null);
    const result = await authFetch('/auth/sessions', { method: 'DELETE' });
    if (result.status !== 200) {
      setError(errorMessage(result.body, 'Could not revoke the other sessions'));
      return;
    }
    setMessage('Other sessions were signed out.');
    await load();
  }

  async function logout(): Promise<void> {
    await authFetch('/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  async function invite(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await authFetch('/staff/invitations', {
      method: 'POST',
      body: { email: inviteEmail, role: inviteRole, password: currentPassword, totp },
    });
    setPending(false);
    if (result.status === 202) {
      setMessage('Invitation requested.');
      setInviteEmail('');
      return;
    }
    setError(errorMessage(result.body, 'Invitation failed'));
  }

  const profile = me?.profile;

  return (
    <AuthChrome
      title="Account security"
      lede="Profile, password, and active sessions for the signed-in account."
    >
      {!profile ? (
        <p className="alert">{error ?? 'Loading account…'}</p>
      ) : (
        <>
          <section className="panel">
            <h2>Profile</h2>
            {profile.emailVerified ? null : (
              <p className="alert bad" role="status">
                Email verification is still required. Challenge purchase and market data stay locked
                until the verification link is used.
              </p>
            )}
            <dl>
              <div>
                <dt>Name</dt>
                <dd>{[profile.firstName, profile.lastName].filter(Boolean).join(' ') || '—'}</dd>
              </div>
              <div>
                <dt>Username</dt>
                <dd>{profile.username ?? '—'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{profile.email}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{profile.phone ?? '—'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{profile.status}</dd>
              </div>
              <div>
                <dt>Email verified</dt>
                <dd>{profile.emailVerified ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{profile.createdAt}</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>{profile.roles.join(', ')}</dd>
              </div>
              <div>
                <dt>MFA</dt>
                <dd>{profile.mfaEnrolled ? 'Enrolled' : 'Not enrolled'}</dd>
              </div>
            </dl>
            <form onSubmit={(event) => void saveProfile(event)}>
              <label>
                Display name
                <input
                  value={displayName}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                  }}
                  maxLength={80}
                />
              </label>
              <div className="form-actions">
                <button className="primary" type="submit" disabled={pending}>
                  Save profile
                </button>
                <a href="/account/mfa">Multi-factor authentication</a>
                <button type="button" onClick={() => void logout()}>
                  Sign out
                </button>
              </div>
            </form>
          </section>
          <section className="panel">
            <h2>Password</h2>
            <form onSubmit={(event) => void changePassword(event)}>
              <label>
                Current password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => {
                    setCurrentPassword(event.target.value);
                  }}
                  required
                />
              </label>
              <label>
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                  }}
                  required
                />
              </label>
              {profile.mfaEnrolled ? (
                <label>
                  Authentication code
                  <input
                    inputMode="numeric"
                    value={totp}
                    onChange={(event) => {
                      setTotp(event.target.value);
                    }}
                    required
                  />
                </label>
              ) : null}
              <div className="form-actions">
                <button className="primary" type="submit" disabled={pending}>
                  Change password
                </button>
              </div>
            </form>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Sessions</h2>
              <button type="button" onClick={() => void revokeOthers()}>
                Sign out other sessions
              </button>
            </div>
            <ul className="session-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <span>
                    {session.current ? 'This session' : 'Other session'} ·{' '}
                    {session.ip ?? 'unknown IP'}
                    <br />
                    {session.userAgent ?? 'Unknown client'}
                  </span>
                  <button type="button" onClick={() => void revoke(session.id)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {me.permissions.includes('staff.invite') && me.mfaSatisfied ? (
            <section className="panel">
              <h2>Invite staff</h2>
              <form onSubmit={(event) => void invite(event)}>
                <label>
                  Email
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => {
                      setInviteEmail(event.target.value);
                    }}
                    required
                  />
                </label>
                <label>
                  Role
                  <select
                    value={inviteRole}
                    onChange={(event) => {
                      setInviteRole(event.target.value);
                    }}
                  >
                    {[
                      'SUPPORT',
                      'RISK',
                      'TRADING_REVIEW',
                      'MANAGEMENT',
                      'FINANCE',
                      'COMPLIANCE',
                      'ADMIN',
                    ].map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="lede">Confirm with your password and authentication code.</p>
                <div className="form-actions">
                  <button className="primary" type="submit" disabled={pending}>
                    Send invitation
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </>
      )}
      {message ? <p className="alert ok">{message}</p> : null}
      {error && profile ? (
        <p className="alert bad" role="alert">
          {error}
        </p>
      ) : null}
    </AuthChrome>
  );
}

function isMe(value: unknown): value is Me {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('profile' in value) ||
    !('permissions' in value)
  ) {
    return false;
  }
  const profile = value.profile;
  return (
    typeof profile === 'object' &&
    profile !== null &&
    'email' in profile &&
    Array.isArray(value.permissions)
  );
}

function isSessionList(value: unknown): value is { sessions: SessionRow[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessions' in value &&
    Array.isArray(value.sessions)
  );
}
