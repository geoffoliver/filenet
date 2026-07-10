'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getNewlyPendingIds, pruneStaleIds } from './friendRequestDiff';
import { getFriends } from '../lib/api';
import { showDesktopNotification } from '../lib/notifications';
import { useToast } from '../components/Toast/ToastProvider';

const POLL_MS = 5_000;
const STORAGE_KEY = 'filenet:notifiedFriendRequestIds';

function loadNotifiedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function saveNotifiedIds(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore — a failed write just means we might re-notify once next session
  }
}

export function useFriendRequestNotifications(): number {
  const [count, setCount] = useState(0);
  const toast = useToast();
  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tick = useCallback(async () => {
    try {
      const friends = await getFriends();
      if (!mountedRef.current) return;

      const pending = friends.filter((f) => f.status === 'INCOMING_PENDING');
      const pendingIds = pending.map((f) => f.id);
      setCount(pending.length);

      const loadedIds = loadNotifiedIds();
      // Prune ids that are no longer pending (accepted/declined since) so a
      // friend that re-enters INCOMING_PENDING under the same id later (e.g.
      // server/friends.ts upgrading an existing row) is treated as a new
      // request rather than silently suppressed forever, and so the
      // persisted set doesn't grow unboundedly.
      const notifiedIds = pruneStaleIds(loadedIds, pendingIds);
      let changed = notifiedIds.size !== loadedIds.size;

      const newIds = getNewlyPendingIds(pendingIds, notifiedIds);

      for (const id of newIds) {
        const friend = pending.find((f) => f.id === id);
        if (!friend) continue;
        const shown = showDesktopNotification(
          'New friend request',
          `${friend.name} wants to be your friend`,
          () => {
            window.focus();
            window.location.href = '/friends';
          },
        );
        if (!shown) toast.show(`${friend.name} wants to be your friend`);
        notifiedIds.add(id);
        changed = true;
      }

      if (changed) saveNotifiedIds(notifiedIds);
    } catch {
      // silent retry, matches app/(shell)/friends/page.tsx's poll-failure convention
    }
  }, [toast]);

  useEffect(() => {
    mountedRef.current = true;

    async function loop() {
      if (!mountedRef.current) return;
      await tick();
      if (mountedRef.current) pollRef.current = setTimeout(loop, POLL_MS);
    }

    loop();
    return () => {
      mountedRef.current = false;
      if (pollRef.current !== null) clearTimeout(pollRef.current);
    };
  }, [tick]);

  return count;
}
