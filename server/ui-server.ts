import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { type ManagementDeps, createManagementFetch } from './management';

export type UiServerDeps = ManagementDeps & {
  outDir: string;
  devOrigin?: string;
  isDev?: boolean;
};

export function createUiServer(deps: UiServerDeps): (req: Request) => Promise<Response> {
  const {
    outDir,
    devOrigin = 'http://localhost:3001',
    isDev = process.env.NODE_ENV !== 'production',
    ...managementDeps
  } = deps;
  const managementFetch = createManagementFetch(managementDeps);

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      if (isDev && req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(devOrigin) });
      }
      const res = await managementFetch(req);
      if (!isDev) return res;
      const headers = new Headers(res.headers);
      for (const [key, value] of Object.entries(corsHeaders(devOrigin))) headers.set(key, value);
      return new Response(res.body, { status: res.status, headers });
    }

    const filePath = resolveStaticFile(outDir, url.pathname);
    if (filePath) return new Response(Bun.file(filePath));

    const notFoundPath = resolveStaticFile(outDir, '/404');
    return new Response(notFoundPath ? Bun.file(notFoundPath) : '404 Not Found', { status: 404 });
  };
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function resolveStaticFile(outDir: string, pathname: string): string | null {
  if (!existsSync(outDir)) return null;

  const normalized = pathname === '/' ? '/index.html' : pathname;
  const resolvedOutDir = realpathSync(outDir) + sep;
  const candidates = [
    join(outDir, normalized),
    join(outDir, `${normalized}.html`),
    join(outDir, normalized, 'index.html'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    // Defense in depth: resolve symlinks before the boundary check (not just
    // the literal path) so a symlink inside outDir pointing outside it can't
    // be used to escape. path.join (unlike path.resolve) never lets a
    // leading slash in `normalized` escape outDir on its own, and the WHATWG
    // URL parser that produces url.pathname already strips literal `..`
    // segments before it reaches this function — but this keeps the
    // guarantee explicit rather than incidental to caller/filesystem state.
    const real = realpathSync(candidate);
    if (!real.startsWith(resolvedOutDir)) continue;
    return real;
  }
  return null;
}
