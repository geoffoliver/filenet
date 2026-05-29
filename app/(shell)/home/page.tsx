import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Home — Filenet' };

export default function HomePage() {
  return (
    <div style={{ padding: '40px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Home</h1>
      <p style={{ color: 'var(--text-muted)' }}>Dashboard coming soon.</p>
    </div>
  );
}
