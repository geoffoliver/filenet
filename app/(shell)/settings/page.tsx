import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Settings — Filenet' };

export default function SettingsPage() {
  return (
    <div style={{ padding: '40px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Settings</h1>
      <p style={{ color: 'var(--text-muted)' }}>Settings coming soon.</p>
    </div>
  );
}
