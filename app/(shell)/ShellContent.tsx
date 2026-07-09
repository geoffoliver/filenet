'use client';

import Navbar from '../components/Navbar/Navbar';
import styles from './layout.module.css';
import { useFriendRequestNotifications } from '../hooks/useFriendRequestNotifications';

export function ShellContent({ children }: { children: React.ReactNode }) {
  const pendingRequestCount = useFriendRequestNotifications();
  return (
    <div className={styles.shell}>
      <Navbar pendingRequestCount={pendingRequestCount} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
