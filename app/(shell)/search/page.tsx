'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import SearchView from './SearchView';

function SearchInner() {
  const params = useSearchParams();
  // Remount SearchView on every new search so state always starts fresh
  return <SearchView key={params.toString()} />;
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchInner />
    </Suspense>
  );
}
