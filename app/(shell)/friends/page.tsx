import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Friends — Filenet' };

export default function FriendsPage() {
  return (
    <div style={{ padding: '40px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Friends</h1>
      <p style={{ color: 'var(--text-muted)' }}>Friends list coming soon.</p>
    </div>
  );
}
