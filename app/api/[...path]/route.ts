import type { NextRequest } from 'next/server';

const MGMT_BASE = process.env.MGMT_URL ?? 'http://127.0.0.1:7735';

async function proxy(req: NextRequest): Promise<Response> {
  const target = `${MGMT_BASE}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return fetch(target, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? req.body : undefined,
    // @ts-expect-error — Node/Bun fetch supports duplex for streaming bodies
    duplex: hasBody ? 'half' : undefined,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
