'use client';

import { getSettings } from './lib/api';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Root() {
  const router = useRouter();

  useEffect(() => {
    getSettings()
      .then((s) => router.replace(s.name ? '/home' : '/setup'))
      .catch(() => router.replace('/setup'));
  }, [router]);

  return null;
}
