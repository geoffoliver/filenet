import type { Metadata } from 'next';

import ChatView from './ChatView';

export const metadata: Metadata = { title: 'Chat — Filenet' };

export default function ChatPage() {
  return <ChatView />;
}
