import { describe, expect, it, mock, spyOn } from 'bun:test';

import { openBrowser } from '../browser-opener';

type FakeSubprocess = { exited: Promise<number>; unref: () => void };

function fakeSpawn(
  calls: unknown[],
  result: { exited: Promise<number> } | (() => never) = { exited: Promise.resolve(0) },
): typeof Bun.spawn {
  return ((opts: unknown) => {
    calls.push(opts);
    if (typeof result === 'function') return result();
    return { ...(result as { exited: Promise<number> }), unref: () => {} } as FakeSubprocess;
  }) as unknown as typeof Bun.spawn;
}

describe('openBrowser', () => {
  it('spawns "open <url>" on darwin', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', { platform: 'darwin', spawnImpl: fakeSpawn(calls) });
    expect(calls).toEqual([
      { cmd: ['open', 'http://localhost:3000'], stdio: ['ignore', 'ignore', 'ignore'] },
    ]);
  });

  it('spawns "cmd /c start \\"\\" <url>" on win32', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', { platform: 'win32', spawnImpl: fakeSpawn(calls) });
    expect(calls).toEqual([
      {
        cmd: ['cmd', '/c', 'start', '""', 'http://localhost:3000'],
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    ]);
  });

  it('spawns "xdg-open <url>" on linux', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', { platform: 'linux', spawnImpl: fakeSpawn(calls) });
    expect(calls).toEqual([
      { cmd: ['xdg-open', 'http://localhost:3000'], stdio: ['ignore', 'ignore', 'ignore'] },
    ]);
  });

  it('falls back to xdg-open on an unrecognized platform', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', {
      platform: 'freebsd' as NodeJS.Platform,
      spawnImpl: fakeSpawn(calls),
    });
    expect(calls).toEqual([
      { cmd: ['xdg-open', 'http://localhost:3000'], stdio: ['ignore', 'ignore', 'ignore'] },
    ]);
  });

  it('logs a warning and does not throw when spawnImpl throws synchronously', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const throwingSpawn = (() => {
      throw new Error('spawn xdg-open ENOENT');
    }) as unknown as typeof Bun.spawn;

    expect(() =>
      openBrowser('http://localhost:3000', { platform: 'linux', spawnImpl: throwingSpawn }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs a warning when the spawned process exits non-zero', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const calls: unknown[] = [];
    const exited = Promise.resolve(1);
    openBrowser('http://localhost:3000', {
      platform: 'darwin',
      spawnImpl: fakeSpawn(calls, { exited }),
    });

    // openBrowser's .then() was attached to `exited` synchronously above, so
    // awaiting the same promise resumes only after that reaction has run —
    // no need for a time-based sleep.
    await exited;

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('unrefs the spawned process so it cannot keep the event loop alive', () => {
    const unref = mock(() => {});
    const spawnImpl = (() => ({
      exited: Promise.resolve(0),
      unref,
    })) as unknown as typeof Bun.spawn;

    openBrowser('http://localhost:3000', { platform: 'darwin', spawnImpl });

    expect(unref).toHaveBeenCalledTimes(1);
  });
});
