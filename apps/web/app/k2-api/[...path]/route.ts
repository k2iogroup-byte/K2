import { proxyTarget } from '../../../lib/api-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'cookie',
  'x-k2-request',
  'x-csrf-token',
  'x-request-id',
];
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'pragma', 'x-request-id', 'retry-after'];

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const target = proxyTarget(
    path,
    new URL(request.url).search,
    process.env.API_PROXY_DESTINATION ?? 'http://127.0.0.1:4000',
  );
  if (!target) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const method = request.method.toUpperCase();
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    });
    const responseHeaders = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    for (const cookie of readSetCookies(upstream.headers)) {
      responseHeaders.append('set-cookie', cookie);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return new Response('The API is unavailable', { status: 502 });
  }
}

function readSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}
