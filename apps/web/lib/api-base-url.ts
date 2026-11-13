export type ApiBaseUrl = { ok: true; baseUrl: string } | { ok: false; reason: string };

export function readApiBaseUrl(value: string | undefined): ApiBaseUrl {
  if (value === undefined || value.trim() === '') {
    return { ok: false, reason: 'NEXT_PUBLIC_API_BASE_URL is not set' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'API base URL is invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'API base URL must be http or https' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'API base URL must not include credentials' };
  }
  return { ok: true, baseUrl: url.origin };
}
