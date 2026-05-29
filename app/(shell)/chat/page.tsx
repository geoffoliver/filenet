import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Chat — Filenet' };

export default function ChatPage() {
  return (
    <div style={{ padding: '40px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Chat</h1>
      <p style={{ color: 'var(--text-muted)' }}>Chat coming soon.</p>
    </div>
  );
}
