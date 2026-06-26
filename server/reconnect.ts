import { inArray } from 'drizzle-orm';

import type { ConnectPeerFn } from './management';
import type { Db } from './db';
import type { Identity } from './identity';
import { friends } from './schema';
import { getConnectedPeer } from './connections';
import { getOrCreateSettings } from './config';

export const RECONNECT_INTERVAL_MS = 30_000;

// Tracks in-flight connection attempts by "address:port" to prevent duplicate dials
// when a previous tick's connection hasn't resolved or rejected yet.
const dialing = new Set<string>();

// Addresses whose dial failure has already been logged — keeps a permanently
// offline friend from producing an error line every tick. Cleared on success
// so a future outage logs again.
const loggedFailures = new Set<string>();

/** @internal – only for use in tests */
export function resetDialingForTesting(): void {
  dialing.clear();
  loggedFailures.clear();
}

/**
 * One reconnect pass: attempts to connect to every ACCEPTED or OUTGOING_PENDING
 * friend that is not currently in the connected-peers map.
 */
export async function reconnectOnce(
  db: Db,
  identity: Identity,
  connectPeer: ConnectPeerFn,
): Promise<void> {
  const [settingsRow, friendRows] = await Promise.all([
    getOrCreateSettings(db),
    Promise.resolve(
      db
        .select()
        .from(friends)
        .where(inArray(friends.status, ['ACCEPTED', 'OUTGOING_PENDING']))
        .all(),
    ),
  ]);

  // Prune loggedFailures entries for friends that were removed or changed
  // address/port — without this the set grows forever on long-running nodes,
  // since the success path (the only other removal) can never fire for them.
  const currentKeys = new Set(friendRows.map((f) => `${f.address}:${f.port}`));
  for (const key of loggedFailures) {
    if (!currentKeys.has(key)) loggedFailures.delete(key);
  }

  for (const friend of friendRows) {
    // Already connected — nothing to do
    if (friend.nodeId && getConnectedPeer(friend.nodeId)) continue;

    const key = `${friend.address}:${friend.port}`;
    // A connection attempt is already in-flight for this address — skip
    if (dialing.has(key)) continue;

    const friendRequest =
      friend.status === 'OUTGOING_PENDING'
        ? {
            name: settingsRow.name.trim() || identity.nodeId,
            ...(friend.remotePassword !== null && { password: friend.remotePassword }),
          }
        : undefined;

    dialing.add(key);
    Promise.resolve()
      .then(() => connectPeer(friend.address, friend.port, friendRequest))
      .then(() => {
        if (loggedFailures.delete(key)) {
          console.log(`[reconnect] ${key} — connected`);
        }
      })
      .catch((err: unknown) => {
        if (!loggedFailures.has(key)) {
          loggedFailures.add(key);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[reconnect] ${key} — ${msg} (will keep retrying quietly)`);
        }
      })
      .finally(() => dialing.delete(key));
  }
}

export function startReconnectLoop(
  db: Db,
  identity: Identity,
  connectPeer: ConnectPeerFn,
  intervalMs = RECONNECT_INTERVAL_MS,
): () => void {
  let running = false;

  function tick(): void {
    if (running) return;
    running = true;
    reconnectOnce(db, identity, connectPeer)
      .catch((err) => console.error('[reconnect] tick error:', err))
      .finally(() => {
        running = false;
      });
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
