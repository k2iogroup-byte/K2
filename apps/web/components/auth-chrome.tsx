import type { ReactElement, ReactNode } from 'react';

export function AuthChrome({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: ReactNode;
}): ReactElement {
  return (
    <main id="content">
      <p className="eyebrow">K2 Group</p>
      <h1>{title}</h1>
      <p className="lede">{lede}</p>
      <nav className="account-nav" aria-label="Account">
        <a href="/login">Sign in</a>
        <a href="/register">Create account</a>
        <a href="/forgot-password">Reset password</a>
        <a href="/account">Profile</a>
      </nav>
      {children}
    </main>
  );
}
