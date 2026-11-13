import { randomUUID } from 'node:crypto';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  if (typeof header === 'string' && REQUEST_ID.test(header)) return header;
  return randomUUID();
}
