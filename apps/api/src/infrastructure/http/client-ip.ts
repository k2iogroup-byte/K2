import { isIP } from 'node:net';

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * The address rate limits and socket admission may use.
 * A value that is not an IP becomes null so callers share one fallback bucket
 * instead of minting a new bucket for every garbage forwarding header.
 * IPv4-mapped IPv6 is stored as IPv4 so one client does not split across two keys.
 */
export function normalizeClientIp(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  const mapped = MAPPED_IPV4.exec(trimmed);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  const version = isIP(trimmed);
  if (version !== 4 && version !== 6) return null;
  return trimmed;
}
