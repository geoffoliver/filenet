import Navbar from '../components/Navbar/Navbar';
import styles from './layout.module.css';

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <Navbar />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
