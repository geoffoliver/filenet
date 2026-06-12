import type { PrismaClient } from '@prisma/client';

import type { ConnectPeerFn } from './management';
import { getConnectedPeer } from './connections';
import { getOrCreateSettings } from './config';

export const RECONNECT_INTERVAL_MS = 30_000;

// Tracks in-flight connection attempts by "address:port" to prevent duplicate dials
// when a previous tick's connection hasn't resolved or rejected yet.
const dialing = new Set<string>();

/** @internal – only for use in tests */
export function resetDialingForTesting(): void {
  dialing.clear();
}

/**
 * One reconnect pass: attempts to connect to every ACCEPTED or OUTGOING_PENDING
 * friend that is not currently in the connected-peers map.
 */
export async function reconnectOnce(
  prisma: PrismaClient,
  connectPeer: ConnectPeerFn,
): Promise<void> {
  const [settings, friends] = await Promise.all([
    getOrCreateSettings(prisma),
    prisma.friend.findMany({
      where: { status: { in: ['ACCEPTED', 'OUTGOING_PENDING'] } },
    }),
  ]);

  for (const friend of friends) {
    // Already connected — nothing to do
    if (friend.nodeId && getConnectedPeer(friend.nodeId)) continue;

    const key = `${friend.address}:${friend.port}`;
    // A connection attempt is already in-flight for this address — skip
    if (dialing.has(key)) continue;

    // OUTGOING_PENDING means we want to send a friend-request after the handshake
    const friendRequest =
      friend.status === 'OUTGOING_PENDING'
        ? { name: settings.name.trim() || friend.name }
        : undefined;

    dialing.add(key);
    connectPeer(friend.address, friend.port, friendRequest)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[reconnect] ${friend.address}:${friend.port} — ${msg}`);
      })
      .finally(() => dialing.delete(key));
  }
}

export function startReconnectLoop(
  prisma: PrismaClient,
  connectPeer: ConnectPeerFn,
  intervalMs = RECONNECT_INTERVAL_MS,
): () => void {
  let running = false;

  function tick(): void {
    if (running) return;
    running = true;
    reconnectOnce(prisma, connectPeer)
      .catch((err) => console.error('[reconnect] tick error:', err))
      .finally(() => {
        running = false;
      });
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
