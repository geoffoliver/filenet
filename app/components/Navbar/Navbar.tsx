'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import Link from 'next/link';
import styles from './Navbar.module.css';

const NAV_LINKS = [
  { href: '/home', label: 'Home' },
  { href: '/search', label: 'Search' },
  { href: '/chat', label: 'Chat' },
  { href: '/friends', label: 'Friends' },
  { href: '/transfers', label: 'Transfers' },
  { href: '/settings', label: 'Settings' },
];

export default function Navbar({ pendingRequestCount = 0 }: { pendingRequestCount?: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState('');

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/search?${new URLSearchParams({ q, type: 'all' })}` : '/search');
  }

  return (
    <nav className={styles.navbar}>
      <Link href="/home" className={styles.brand}>
        File<span>net</span>
      </Link>

      <div className={styles.nav}>
        {NAV_LINKS.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`${styles.navLink} ${pathname.startsWith(href) ? styles.active : ''}`}
          >
            {label}
            {href === '/friends' && pendingRequestCount > 0 && (
              <span className={styles.badge}>{pendingRequestCount}</span>
            )}
          </Link>
        ))}
      </div>

      <form className={styles.searchForm} onSubmit={handleSearch}>
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search files"
        />
        <button type="submit" className={styles.searchBtn}>
          Search
        </button>
      </form>
    </nav>
  );
}
