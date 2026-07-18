import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Filenet',
    short_name: 'Filenet',
    description: 'Self-hosted, peer-to-peer file sharing and chat',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f4f5',
    theme_color: '#3b82f6',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
