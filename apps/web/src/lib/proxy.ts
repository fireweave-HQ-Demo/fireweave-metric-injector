import { NextRequest, NextResponse } from 'next/server';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'host', 'content-length']);

export async function proxyRequest(
  request: NextRequest,
  prefix: string,
  segments: string[],
): Promise<NextResponse> {
  const api = process.env.API_URL ?? 'http://127.0.0.1:3000';
  const target = `${api}${prefix}/${segments.join('/')}${request.nextUrl.search}`;
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await request.arrayBuffer(),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { error: { code: 'UNAVAILABLE', message: 'The API is not reachable' } },
      { status: 502 },
    );
  }
  const outgoing = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie' || HOP.has(key.toLowerCase())) {
      return;
    }
    outgoing.set(key, value);
  });
  for (const cookie of response.headers.getSetCookie()) {
    outgoing.append('set-cookie', cookie);
  }
  return new NextResponse(response.status === 204 ? null : response.body, {
    status: response.status,
    headers: outgoing,
  });
}
