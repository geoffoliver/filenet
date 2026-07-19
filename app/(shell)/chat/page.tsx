import type { Metadata } from 'next';
import { Suspense } from 'react';

import ChatView from './ChatView';

export const metadata: Metadata = { title: 'Chat — Filenet' };

export default function ChatPage() {
  return (
    <Suspense>
      <ChatView />
    </Suspense>
  );
}
