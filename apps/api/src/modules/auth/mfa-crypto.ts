import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedSecret = {
  ciphertext: string;
  nonce: string;
};

export function encryptSecret(key: Buffer, plaintext: string, aad: string): EncryptedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

export function decryptSecret(key: Buffer, encrypted: EncryptedSecret, aad: string): string | null {
  try {
    const nonce = Buffer.from(encrypted.nonce, 'base64');
    const payload = Buffer.from(encrypted.ciphertext, 'base64');
    if (nonce.length !== 12 || payload.length < 17) return null;
    const tag = payload.subarray(payload.length - 16);
    const data = payload.subarray(0, payload.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
