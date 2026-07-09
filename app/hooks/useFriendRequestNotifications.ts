'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getFriends } from '../lib/api';
import { getNewlyPendingIds } from './friendRequestDiff';
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
      setCount(pending.length);

      const notifiedIds = loadNotifiedIds();
      const newIds = getNewlyPendingIds(
        pending.map((f) => f.id),
        notifiedIds,
      );

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
      }

      if (newIds.length > 0) saveNotifiedIds(notifiedIds);
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
