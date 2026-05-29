import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Transfers — Filenet' };

export default function TransfersPage() {
  return (
    <div style={{ padding: '40px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Transfers</h1>
      <p style={{ color: 'var(--text-muted)' }}>Transfers coming soon.</p>
    </div>
  );
}
