'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import styles from './Toast.module.css';

type ToastItem = { id: string; message: string };
type ToastContextValue = { show: (message: string) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 5_000;

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Clear any pending dismiss timers on unmount, so a stale timeout can't
  // fire against a ToastProvider instance that's no longer mounted (e.g.
  // navigating out of the (shell) route group entirely, to /setup).
  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      timeouts.forEach(clearTimeout);
      timeouts.clear();
    };
  }, []);

  const show = useCallback((message: string) => {
    const id = String(idRef.current++);
    setToasts((current) => [...current, { id, message }]);
    const timeoutId = setTimeout(() => {
      timeoutsRef.current.delete(timeoutId);
      setToasts((current) => current.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
    timeoutsRef.current.add(timeoutId);
  }, []);

  // Memoized so the context value's identity only changes when `show` does
  // (never, since it has no deps) — otherwise every toast add/remove would
  // change the context value identity and needlessly re-trigger effects in
  // any consumer that depends on it (e.g. useFriendRequestNotifications'
  // polling loop would tear down and restart on every toast shown).
  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.container} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
