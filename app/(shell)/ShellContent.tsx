'use client';

import Navbar from '../components/Navbar/Navbar';
import styles from './layout.module.css';
import { useFriendRequestNotifications } from '../hooks/useFriendRequestNotifications';
import { useUpdateNotifications } from '../hooks/useUpdateNotifications';

export function ShellContent({ children }: { children: React.ReactNode }) {
  const pendingRequestCount = useFriendRequestNotifications();
  useUpdateNotifications();
  return (
    <div className={styles.shell}>
      <Navbar pendingRequestCount={pendingRequestCount} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
