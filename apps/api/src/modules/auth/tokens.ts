import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function newRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = randomBytes(12);
    let raw = '';
    for (const byte of bytes) {
      raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length] ?? 'A';
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/-/g, '');
}
