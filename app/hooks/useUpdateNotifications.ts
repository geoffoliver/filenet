'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getUpdateStatus } from '../lib/api';
import { shouldNotifyForUpdate } from './updateNotificationDiff';
import { showDesktopNotification } from '../lib/notifications';
import { useToast } from '../components/Toast/ToastProvider';

const POLL_MS = 60_000;
const STORAGE_KEY = 'filenet:notifiedUpdateVersions';

function loadNotifiedVersions(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function saveNotifiedVersions(versions: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...versions]));
  } catch {
    // ignore — a failed write just means we might re-notify once next session
  }
}

export function useUpdateNotifications(): void {
  const toast = useToast();
  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tick = useCallback(async () => {
    try {
      const status = await getUpdateStatus();
      if (!mountedRef.current) return;

      const newVersion = shouldNotifyForUpdate(
        status.phase,
        status.latestVersion,
        loadNotifiedVersions(),
      );
      if (newVersion) {
        const notifiedVersions = loadNotifiedVersions();
        const shown = showDesktopNotification(
          'Filenet update ready',
          `v${newVersion} is ready to install`,
          () => {
            window.focus();
            window.location.href = '/settings';
          },
        );
        if (!shown) toast.show(`Filenet v${newVersion} is ready to install`);
        notifiedVersions.add(newVersion);
        saveNotifiedVersions(notifiedVersions);
      }
    } catch {
      // silent retry, matches useFriendRequestNotifications' poll-failure convention
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
}
