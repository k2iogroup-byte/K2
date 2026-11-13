import { emailSchema, passwordSchema } from '@k2/shared';

import { loadConfig } from '../config/env.js';
import { loadEnvFile } from '../config/load-env-file.js';
import { resolveEnvFile } from '../config/paths.js';
import { IdentityRepository } from '../infrastructure/db/identity-repository.js';
import { createPool } from '../infrastructure/db/pool.js';
import { ARGON2_PARAMETERS, hashPassword } from '../modules/auth/passwords.js';
import { isDirectRun } from '../runtime/is-direct-run.js';

const CONFIRM = 'create-first-admin';
const WEAK = new Set([
  'password',
  'changeme',
  'secret',
  'postgres',
  'k2',
  'k2_ci_test_password',
  'local-dev-password-value',
]);

export async function createInitialAdmin(
  repository: IdentityRepository,
  email: string,
  password: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const parsedEmail = emailSchema.safeParse(email);
  const parsedPassword = passwordSchema.safeParse(password);
  if (!parsedEmail.success || !parsedPassword.success) {
    throw new Error('Bootstrap email or password does not meet the baseline');
  }
  if (
    password.toLowerCase().includes('replace_with') ||
    WEAK.has(password.toLowerCase()) ||
    password.toLowerCase() === parsedEmail.data
  ) {
    throw new Error('Bootstrap email or password does not meet the baseline');
  }
  if ((await repository.countAdmins()) > 0) {
    throw new Error('An administrator already exists');
  }
  if (await repository.emailExists(parsedEmail.data)) {
    throw new Error('Bootstrap refused because that email is already registered');
  }
  const passwordHash = await hashPassword(parsedPassword.data);
  return repository.transaction(async (client) => {
    const userId = await repository.insertUser(client, {
      email: parsedEmail.data,
      passwordHash,
      parameters: ARGON2_PARAMETERS,
      role: 'ADMIN',
      grantedBy: null,
      emailVerified: true,
      profile: null,
    });
    await repository.insertAudit(
      {
        eventType: 'staff.bootstrapped',
        actorUserId: userId,
        targetUserId: userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { role: 'ADMIN' },
      },
      client,
    );
    return userId;
  });
}

async function main(): Promise<void> {
  const envFile = resolveEnvFile();
  if (envFile) loadEnvFile(envFile);
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? '';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (email === '' || password === '') {
    process.stderr.write('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required\n');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(process.env);
  if (config.appEnv !== 'development' && process.env.BOOTSTRAP_ADMIN_CONFIRM !== CONFIRM) {
    process.stderr.write(
      'Refusing bootstrap outside development without BOOTSTRAP_ADMIN_CONFIRM=create-first-admin\n',
    );
    process.exitCode = 1;
    return;
  }
  const pool = createPool(config);
  try {
    const userId = await createInitialAdmin(new IdentityRepository(pool), email, password, {
      ip: null,
      userAgent: 'staff-bootstrap',
    });
    process.stdout.write(
      `Administrator created. Enroll MFA before using staff tools. User id: ${userId}\n`,
    );
  } finally {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Bootstrap failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
