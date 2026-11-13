import { hash, verify } from '@node-rs/argon2';

export const ARGON2_PARAMETERS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  // @node-rs/argon2 defaults to Argon2id. The PHC prefix is checked by tests.
  return hash(password, {
    memoryCost: ARGON2_PARAMETERS.memoryCost,
    timeCost: ARGON2_PARAMETERS.timeCost,
    parallelism: ARGON2_PARAMETERS.parallelism,
  });
}

export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}
