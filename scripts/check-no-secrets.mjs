import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .map((file) => file.trim())
  .filter((file) => file !== '');

const failures = [];
const urlPattern = /postgres(?:ql)?:\/\/([^:\s]+):([^@\s]+)@/gi;
const fixturePasswords = new Set(['REPLACE_WITH_LOCAL_PASSWORD', 'local-dev-password-value']);
const privateKey = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/;
const awsKey = /AKIA[0-9A-Z]{16}/;

for (const file of files) {
  const base = file.split('/').pop() ?? file;
  if (base === '.env' || (base.startsWith('.env.') && !base.endsWith('.example'))) {
    failures.push(`${file}: environment file with credentials must not be tracked`);
  }
  if (base.endsWith('.pem') || base.endsWith('.key')) {
    failures.push(`${file}: key material must not be tracked`);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (privateKey.test(text)) failures.push(`${file}: private key block`);
  if (awsKey.test(text)) failures.push(`${file}: AWS access key id pattern`);
  for (const match of text.matchAll(urlPattern)) {
    const password = match[2] ?? '';
    const allowedFixture = fixturePasswords.has(password) || password.includes('${');
    const allowedCi = file === '.github/workflows/ci.yml' && password === 'k2_ci_test_password';
    if (!allowedFixture && !allowedCi) {
      failures.push(`${file}: database URL password is not an allowed placeholder`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`checked ${files.length} files; no tracked secrets found\n`);
