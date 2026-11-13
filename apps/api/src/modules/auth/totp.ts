import { Secret, TOTP } from 'otpauth';

const ISSUER = 'K2 Group';

export function createTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function factor(email: string, secret: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

export function totpUri(email: string, secret: string): string {
  return factor(email, secret).toString();
}

export function totpValid(
  email: string,
  secret: string,
  code: string,
  timestamp = Date.now(),
): boolean {
  const delta = factor(email, secret).validate({ token: code, timestamp, window: 1 });
  return delta !== null;
}
