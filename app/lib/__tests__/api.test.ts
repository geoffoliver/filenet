import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { apiUrl } from '../api';

let originalDevApiPort: string | undefined;
let originalWindow: unknown;

beforeEach(() => {
  originalDevApiPort = process.env.NEXT_PUBLIC_DEV_API_PORT;
  originalWindow = (globalThis as any).window;
});

afterEach(() => {
  if (originalDevApiPort === undefined) delete process.env.NEXT_PUBLIC_DEV_API_PORT;
  else process.env.NEXT_PUBLIC_DEV_API_PORT = originalDevApiPort;
  (globalThis as any).window = originalWindow;
});

function installFakeWindow(protocol: string, hostname: string): void {
  (globalThis as any).window = { location: { protocol, hostname } };
}

describe('apiUrl', () => {
  test('returns a plain relative path when NEXT_PUBLIC_DEV_API_PORT is unset (production: same-origin)', () => {
    delete process.env.NEXT_PUBLIC_DEV_API_PORT;
    installFakeWindow('https:', 'example.com');

    expect(apiUrl('/api/settings')).toBe('/api/settings');
  });

  test('returns a relative path when NEXT_PUBLIC_DEV_API_PORT is empty (e2e override)', () => {
    process.env.NEXT_PUBLIC_DEV_API_PORT = '';
    installFakeWindow('http:', 'localhost');

    expect(apiUrl('/api/settings')).toBe('/api/settings');
  });

  test('derives the host from window.location rather than a hardcoded literal', () => {
    process.env.NEXT_PUBLIC_DEV_API_PORT = '3000';
    installFakeWindow('http:', '192.168.1.50');

    expect(apiUrl('/api/settings')).toBe('http://192.168.1.50:3000/api/settings');
  });

  test('uses the visiting device page protocol, not a hardcoded one', () => {
    process.env.NEXT_PUBLIC_DEV_API_PORT = '3000';
    installFakeWindow('https:', 'my-dev-box.local');

    expect(apiUrl('/api/stats')).toBe('https://my-dev-box.local:3000/api/stats');
  });

  test('falls back to a relative path when window is unavailable (e.g. SSR) even with a dev port set', () => {
    process.env.NEXT_PUBLIC_DEV_API_PORT = '3000';
    delete (globalThis as any).window;

    expect(apiUrl('/api/settings')).toBe('/api/settings');
  });
});
