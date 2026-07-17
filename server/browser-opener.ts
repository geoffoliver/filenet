export type OpenBrowserOptions = {
  spawnImpl?: typeof Bun.spawn;
  platform?: NodeJS.Platform;
};

function commandFor(platform: NodeJS.Platform, url: string): string[] {
  if (platform === 'darwin') return ['open', url];
  // The literal `""` argument is required: `start` treats the first quoted
  // argument as a window title, not the URL to open, so an empty title must
  // be supplied explicitly.
  if (platform === 'win32') return ['cmd', '/c', 'start', '""', url];
  return ['xdg-open', url];
}

/**
 * Best-effort: opens `url` in the OS default browser. Never throws and
 * never blocks the caller — a missing browser opener (e.g. no xdg-open in
 * a headless container) is logged and otherwise ignored.
 */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void {
  const spawnImpl = opts.spawnImpl ?? Bun.spawn;
  const platform = opts.platform ?? process.platform;
  const cmd = commandFor(platform, url);

  try {
    const proc = spawnImpl({ cmd, stdio: ['ignore', 'ignore', 'ignore'] });
    proc.exited
      .then((code) => {
        if (code !== 0) {
          console.warn(
            `Failed to open browser at ${url}: "${cmd.join(' ')}" exited with code ${code}`,
          );
        }
      })
      .catch((err) => {
        console.warn(`Failed to open browser at ${url}: ${err}`);
      });
  } catch (err) {
    console.warn(`Failed to open browser at ${url}: ${err}`);
  }
}
