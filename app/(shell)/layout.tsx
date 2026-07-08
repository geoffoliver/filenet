'use client';

import Navbar from '../components/Navbar/Navbar';
import { ToastProvider } from '../components/Toast/ToastProvider';
import styles from './layout.module.css';
import { useFriendRequestNotifications } from '../hooks/useFriendRequestNotifications';

function ShellContent({ children }: { children: React.ReactNode }) {
  const pendingRequestCount = useFriendRequestNotifications();
  return (
    <div className={styles.shell}>
      <Navbar pendingRequestCount={pendingRequestCount} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ShellContent>{children}</ShellContent>
    </ToastProvider>
  );
}
