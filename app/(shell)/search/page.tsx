import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Search — Filenet' };

export default function SearchPage() {
  return (
    <div style={{ padding: '40px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Search</h1>
      <p style={{ color: 'var(--text-muted)' }}>File search coming soon.</p>
    </div>
  );
}
