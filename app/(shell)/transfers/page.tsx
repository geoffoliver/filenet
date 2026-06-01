import type { Metadata } from 'next';

import TransfersView from './TransfersView';

export const metadata: Metadata = { title: 'Transfers — Filenet' };

export default function TransfersPage() {
  return <TransfersView />;
}
