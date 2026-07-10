import { ShellContent } from './ShellContent';
import { ToastProvider } from '../components/Toast/ToastProvider';

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ShellContent>{children}</ShellContent>
    </ToastProvider>
  );
}
