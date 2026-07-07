# Notifications (Incoming Friend Requests) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the user when a friend request arrives — a real desktop `Notification` if permission is granted, an in-app toast fallback otherwise — plus a persistent count badge on the Friends nav link, all working regardless of which page the user is currently on.

**Architecture:** A single polling hook (`useFriendRequestNotifications`), mounted once in the shell layout, polls `/api/friends` every 5s exactly like the existing Friends page already does. It diffs newly-`INCOMING_PENDING` friend ids against a `localStorage`-persisted "already notified" set (a pure, directly-tested function), fires a notification for genuinely new ones, and returns the live pending count for a nav badge. No new shared data-store/context is introduced beyond a small, purpose-built `ToastProvider` (an ephemeral message queue) — every page continues to poll its own data independently, matching this codebase's existing convention.

**Tech Stack:** Next.js 16 (App Router, client components), React, the browser `Notification` Web API, `localStorage`, Playwright (frontend), `bun:test` (pure logic).

## Global Constraints

- TDD is required for every pure, non-browser-dependent function (matches this project's convention). React components/hooks that need a real DOM to exercise meaningfully (there is no React Testing Library / jsdom setup in this project — only Playwright drives a real browser) are verified via Playwright once wired together, not via `bun:test`.
- Do not introduce a new shared/global data-store or context for friend data. Every existing page (`Chat`, `Friends`, `Transfers`) polls its own data independently in its own `useEffect`/`setTimeout` loop; this feature's own poll follows the same pattern. The one exception is `ToastProvider`, which is unavoidable (a toast must render across page navigation) and is scoped narrowly to an ephemeral message queue, not general app data.
- `Notification.requestPermission()` must only ever be called from a direct user-gesture handler (a real click). Never call it from a poll/timer callback — browsers silently ignore or auto-deny such calls.
- Never bypass git hooks (`--no-verify`). `.husky/pre-commit` runs `bunx lint-staged` (ESLint + Prettier on staged files) — all new/changed files must pass both before committing.
- `eslint.config.mjs` sets `@typescript-eslint/no-explicit-any: 'off'` — `any` casts are fine in this codebase, including for stubbing browser globals in tests.
- ESLint's `sort-imports` rule is not reliably auto-fixed by `eslint --fix` for multi-specifier import declarations — if it complains, reorder the import lines by hand.
- `POLL_MS = 5_000` is this codebase's established polling interval for this kind of low-urgency data (matches `app/(shell)/friends/page.tsx`); use the same value here for consistency.

---

### Task 1: `app/lib/notifications.ts` — permission + desktop notification helpers

**Files:**

- Create: `app/lib/notifications.ts`
- Test: `app/lib/__tests__/notifications.test.ts`
- Modify: `package.json` (`"test"` script)
- Modify: `.github/workflows/ci.yml` (`Test` step)
- Modify: `.github/workflows/release.yml` (`Test` step)

**Interfaces:**

- Produces: `export type NotificationPermissionState = NotificationPermission | 'unsupported';`
- Produces: `export function getNotificationPermission(): NotificationPermissionState`
- Produces: `export function requestNotificationPermission(): Promise<NotificationPermissionState>` — must only be called from a click handler by its caller (this function itself has no way to enforce that; documented via the Global Constraints above).
- Produces: `export function showDesktopNotification(title: string, body: string, onClick?: () => void): boolean` — returns `true` if a real `Notification` was constructed (permission was `'granted'`), `false` otherwise (caller should fall back to a toast).

- [ ] **Step 1: Write the failing tests**

Create `app/lib/__tests__/notifications.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  getNotificationPermission,
  requestNotificationPermission,
  showDesktopNotification,
} from '../notifications';

let originalNotification: unknown;

beforeEach(() => {
  originalNotification = (globalThis as any).Notification;
});

afterEach(() => {
  (globalThis as any).Notification = originalNotification;
});

type NotificationInstance = { title: string; body?: string; onclick: (() => void) | null };

function installFakeNotification(
  permission: 'default' | 'granted' | 'denied',
  requestResult?: 'default' | 'granted' | 'denied',
): NotificationInstance[] {
  const instances: NotificationInstance[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => requestResult ?? permission;
    onclick: (() => void) | null = null;
    constructor(
      public title: string,
      public options?: { body?: string },
    ) {
      instances.push({ title, body: options?.body, onclick: null });
    }
  }
  (globalThis as any).Notification = FakeNotification;
  return instances;
}

describe('getNotificationPermission', () => {
  test('returns "unsupported" when Notification is not defined', () => {
    (globalThis as any).Notification = undefined;
    expect(getNotificationPermission()).toBe('unsupported');
  });

  test('returns the current permission when supported', () => {
    installFakeNotification('granted');
    expect(getNotificationPermission()).toBe('granted');
  });
});

describe('requestNotificationPermission', () => {
  test('returns "unsupported" when Notification is not defined', async () => {
    (globalThis as any).Notification = undefined;
    expect(await requestNotificationPermission()).toBe('unsupported');
  });

  test('resolves with the result of Notification.requestPermission()', async () => {
    installFakeNotification('default', 'granted');
    expect(await requestNotificationPermission()).toBe('granted');
  });
});

describe('showDesktopNotification', () => {
  test('returns false and does not construct a Notification when permission is not granted', () => {
    const instances = installFakeNotification('denied');
    const result = showDesktopNotification('Title', 'Body');
    expect(result).toBe(false);
    expect(instances.length).toBe(0);
  });

  test('constructs a Notification and returns true when permission is granted', () => {
    const instances = installFakeNotification('granted');
    const result = showDesktopNotification('Title', 'Body');
    expect(result).toBe(true);
    expect(instances.length).toBe(1);
    expect(instances[0].title).toBe('Title');
    expect(instances[0].body).toBe('Body');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test app/lib/__tests__/notifications.test.ts`
Expected: FAIL — `error: Cannot find module '../notifications'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `app/lib/notifications.ts`:

```typescript
export type NotificationPermissionState = NotificationPermission | 'unsupported';

export function getNotificationPermission(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return await Notification.requestPermission();
}

export function showDesktopNotification(
  title: string,
  body: string,
  onClick?: () => void,
): boolean {
  if (getNotificationPermission() !== 'granted') return false;
  const notification = new Notification(title, { body });
  if (onClick) notification.onclick = onClick;
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test app/lib/__tests__/notifications.test.ts`
Expected: PASS — 6 tests, 0 fail.

- [ ] **Step 5: Wire the new test directory into the test command and CI**

Modify `package.json` — change:

```json
    "test": "bun test server/__tests__ scripts/__tests__",
```

to:

```json
    "test": "bun test server/__tests__ scripts/__tests__ app/lib/__tests__",
```

Modify `.github/workflows/ci.yml` — change the `Test` step's `run:` line from:

```yaml
- name: Test
  run: bun test server/__tests__ scripts/__tests__
```

to:

```yaml
- name: Test
  run: bun test server/__tests__ scripts/__tests__ app/lib/__tests__
```

Modify `.github/workflows/release.yml` — change its `Test` step the same way, from:

```yaml
- name: Test
  run: bun test server/__tests__ scripts/__tests__
```

to:

```yaml
- name: Test
  run: bun test server/__tests__ scripts/__tests__ app/lib/__tests__
```

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `bun run test`
Expected: PASS — all existing tests plus the 6 new ones, 0 fail.

- [ ] **Step 7: Lint, format, and commit**

Run: `bunx eslint --max-warnings=0 app/lib/notifications.ts app/lib/__tests__/notifications.test.ts && bunx prettier --check app/lib/notifications.ts app/lib/__tests__/notifications.test.ts package.json .github/workflows/ci.yml .github/workflows/release.yml`
Expected: no errors. If Prettier complains, run `bunx prettier --write <the failing paths>` and re-check. If ESLint complains about `sort-imports`, reorder the import lines by hand (`eslint --fix` doesn't reliably fix this rule).

```bash
git add app/lib/notifications.ts app/lib/__tests__/notifications.test.ts package.json .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "feat(notifications): add notification permission + desktop notification helpers"
```

---

### Task 2: Toast system + friend-request diffing + the polling hook

**Files:**

- Create: `app/hooks/friendRequestDiff.ts`
- Test: `app/hooks/__tests__/friendRequestDiff.test.ts`
- Create: `app/components/Toast/ToastProvider.tsx`
- Create: `app/components/Toast/Toast.module.css`
- Create: `app/hooks/useFriendRequestNotifications.ts`
- Modify: `package.json` (`"test"` script)
- Modify: `.github/workflows/ci.yml` (`Test` step)
- Modify: `.github/workflows/release.yml` (`Test` step)

**Interfaces:**

- Consumes: `showDesktopNotification` from `app/lib/notifications.ts` (Task 1).
- Consumes: `getFriends` and the `Friend` type from `app/lib/api.ts` (existing) — `Friend` has `id: string`, `name: string`, `status: FriendStatus` where `FriendStatus` includes `'INCOMING_PENDING'`.
- Produces: `export function getNewlyPendingIds(pendingIds: string[], notifiedIds: Set<string>): string[]` (`app/hooks/friendRequestDiff.ts`) — pure; returns the subset of `pendingIds` not present in `notifiedIds`, preserving order.
- Produces: `export function useToast(): { show: (message: string) => void }` and `export function ToastProvider({ children }: { children: React.ReactNode }): JSX.Element` (`app/components/Toast/ToastProvider.tsx`) — `useToast()` throws if called outside a `ToastProvider`.
- Produces: `export function useFriendRequestNotifications(): number` (`app/hooks/useFriendRequestNotifications.ts`) — must be called from a component rendered inside `<ToastProvider>`; returns the current count of `INCOMING_PENDING` friends, polling every 5s.

`friendRequestDiff.ts` has **zero imports** — deliberately, so `bun:test` never has to load React/JSX transitively for this test. Keep it that way; do not merge this function into a file that imports React.

- [ ] **Step 1: Write the failing test for the pure diff function**

Create `app/hooks/__tests__/friendRequestDiff.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import { getNewlyPendingIds } from '../friendRequestDiff';

describe('getNewlyPendingIds', () => {
  test('returns all pending ids when none have been notified yet', () => {
    expect(getNewlyPendingIds(['a', 'b'], new Set())).toEqual(['a', 'b']);
  });

  test('excludes ids that have already been notified', () => {
    expect(getNewlyPendingIds(['a', 'b'], new Set(['a']))).toEqual(['b']);
  });

  test('returns an empty array when all pending ids have already been notified', () => {
    expect(getNewlyPendingIds(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });

  test('returns an empty array when there are no pending ids', () => {
    expect(getNewlyPendingIds([], new Set(['a']))).toEqual([]);
  });

  test('ignores notified ids that are no longer pending (e.g. accepted or declined since)', () => {
    expect(getNewlyPendingIds(['b'], new Set(['a', 'b']))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test app/hooks/__tests__/friendRequestDiff.test.ts`
Expected: FAIL — `error: Cannot find module '../friendRequestDiff'`.

- [ ] **Step 3: Write the minimal implementation**

Create `app/hooks/friendRequestDiff.ts`:

```typescript
export function getNewlyPendingIds(pendingIds: string[], notifiedIds: Set<string>): string[] {
  return pendingIds.filter((id) => !notifiedIds.has(id));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test app/hooks/__tests__/friendRequestDiff.test.ts`
Expected: PASS — 5 tests, 0 fail.

- [ ] **Step 5: Build the toast provider (no automated test — see note)**

There is no automated test for this step: it's a React component with no pure logic to extract, and this project has no DOM-testing setup outside Playwright. It's exercised end-to-end in Task 3's `e2e/notifications.spec.ts`. Write it carefully and re-check it against Task 3's test once that lands.

Create `app/components/Toast/Toast.module.css`:

```css
@reference 'tailwindcss';

.container {
  @apply fixed
    bottom-4
    right-4
    z-100
    flex
    flex-col
    gap-2
    pointer-events-none;
}

.toast {
  @apply px-4
    py-3
    rounded-[var(--radius-md)]
    bg-[var(--bg-elevated)]
    text-[var(--text-primary)]
    text-sm
    shadow-[var(--shadow-md)]
    border
    border-[var(--border)];
  max-width: 320px;
}
```

Create `app/components/Toast/ToastProvider.tsx`:

```tsx
'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import styles from './Toast.module.css';

type ToastItem = { id: string; message: string };
type ToastContextValue = { show: (message: string) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 5_000;

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const show = useCallback((message: string) => {
    const id = String(idRef.current++);
    setToasts((current) => [...current, { id, message }]);
    setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  // Memoized so the context value's identity only changes when `show` does
  // (never, since it has no deps) — otherwise every toast add/remove would
  // change the context value identity and needlessly re-trigger effects in
  // any consumer that depends on it (e.g. useFriendRequestNotifications'
  // polling loop would tear down and restart on every toast shown).
  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.container} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
```

- [ ] **Step 6: Build the polling hook (no automated test — see note)**

Same testing note as Step 5: no `bun:test` for this hook itself (it needs a real DOM/React tree); exercised end-to-end in Task 3's `e2e/notifications.spec.ts`.

Create `app/hooks/useFriendRequestNotifications.ts`:

```typescript
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '../components/Toast/ToastProvider';
import { getNewlyPendingIds } from './friendRequestDiff';
import { getFriends } from '../lib/api';
import { showDesktopNotification } from '../lib/notifications';

const POLL_MS = 5_000;
const STORAGE_KEY = 'filenet:notifiedFriendRequestIds';

function loadNotifiedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function saveNotifiedIds(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore — a failed write just means we might re-notify once next session
  }
}

export function useFriendRequestNotifications(): number {
  const [count, setCount] = useState(0);
  const toast = useToast();
  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tick = useCallback(async () => {
    try {
      const friends = await getFriends();
      if (!mountedRef.current) return;

      const pending = friends.filter((f) => f.status === 'INCOMING_PENDING');
      setCount(pending.length);

      const notifiedIds = loadNotifiedIds();
      const newIds = getNewlyPendingIds(
        pending.map((f) => f.id),
        notifiedIds,
      );

      for (const id of newIds) {
        const friend = pending.find((f) => f.id === id);
        if (!friend) continue;
        const shown = showDesktopNotification(
          'New friend request',
          `${friend.name} wants to be your friend`,
          () => {
            window.focus();
            window.location.href = '/friends';
          },
        );
        if (!shown) toast.show(`${friend.name} wants to be your friend`);
        notifiedIds.add(id);
      }

      if (newIds.length > 0) saveNotifiedIds(notifiedIds);
    } catch {
      // silent retry, matches app/(shell)/friends/page.tsx's poll-failure convention
    }
  }, [toast]);

  useEffect(() => {
    mountedRef.current = true;

    async function loop() {
      if (!mountedRef.current) return;
      await tick();
      if (mountedRef.current) pollRef.current = setTimeout(loop, POLL_MS);
    }

    loop();
    return () => {
      mountedRef.current = false;
      if (pollRef.current !== null) clearTimeout(pollRef.current);
    };
  }, [tick]);

  return count;
}
```

- [ ] **Step 7: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Wire the new test directory into the test command and CI**

Modify `package.json` — change:

```json
    "test": "bun test server/__tests__ scripts/__tests__ app/lib/__tests__",
```

to:

```json
    "test": "bun test server/__tests__ scripts/__tests__ app/lib/__tests__ app/hooks/__tests__",
```

Modify `.github/workflows/ci.yml`'s `Test` step the same way, and `.github/workflows/release.yml`'s `Test` step the same way — both from:

```yaml
run: bun test server/__tests__ scripts/__tests__ app/lib/__tests__
```

to:

```yaml
run: bun test server/__tests__ scripts/__tests__ app/lib/__tests__ app/hooks/__tests__
```

- [ ] **Step 9: Run the full test suite to confirm nothing else broke**

Run: `bun run test`
Expected: PASS — 0 fail.

- [ ] **Step 10: Lint, format, and commit**

Run: `bunx eslint --max-warnings=0 app/hooks/friendRequestDiff.ts app/hooks/__tests__/friendRequestDiff.test.ts app/components/Toast/ToastProvider.tsx app/hooks/useFriendRequestNotifications.ts && bunx prettier --check app/hooks/friendRequestDiff.ts app/hooks/__tests__/friendRequestDiff.test.ts app/components/Toast/ToastProvider.tsx app/components/Toast/Toast.module.css app/hooks/useFriendRequestNotifications.ts package.json .github/workflows/ci.yml .github/workflows/release.yml`
Expected: no errors. Fix formatting with `bunx prettier --write <path>` and re-check; fix `sort-imports` complaints by hand.

```bash
git add app/hooks/friendRequestDiff.ts app/hooks/__tests__/friendRequestDiff.test.ts app/components/Toast/ToastProvider.tsx app/components/Toast/Toast.module.css app/hooks/useFriendRequestNotifications.ts package.json .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "feat(notifications): add toast provider, friend-request diffing, and the polling hook"
```

---

### Task 3: Wire into the shell, add the nav badge, fix an e2e fixture regression risk

**Context on the regression risk (read before starting):** `e2e/helpers.ts`'s default `FRIENDS` fixture has always included one `INCOMING_PENDING` entry (`'friend-3'`, Carol) — used today only by `friends.spec.ts`. Once this task mounts the polling hook globally in the shell layout, **every** e2e test that calls `mockBaseApp()` (nearly all of them, across every spec file) will suddenly have an incoming pending friend in scope, causing a toast/notification to fire during unrelated tests (e.g. Chat, Search, Settings, Transfers, Setup specs) and, worse, breaking `friends.spec.ts`'s own `getByText('Carol')` assertions once a second "Carol" appears inside a toast message. This task's steps below fix that by changing the default fixture to have Carol already `ACCEPTED`, and introduce a separate `FRIENDS_WITH_INCOMING_REQUEST` fixture for the tests that specifically need a pending request.

There's a second, related risk: `app/(shell)/friends/page.tsx` already polls `/api/friends` on its own 5s timer. After this task, the shell-level hook polls the _same_ endpoint independently. Two `friends.spec.ts` tests ("accepting…" and "rejecting…") currently key their mock's response on a raw `callCount` of GET requests — with two independent pollers now hitting `/api/friends` on `/friends` page mount, that counter can advance faster than the test's click, returning the "already accepted/rejected" list before the button is ever clicked. This task rewrites those two tests to key off of whether the actual PUT request happened, not a raw count — correct regardless of how many pollers exist.

**Files:**

- Modify: `app/(shell)/layout.tsx`
- Modify: `app/components/Navbar/Navbar.tsx`
- Modify: `app/components/Navbar/Navbar.module.css`
- Modify: `e2e/helpers.ts`
- Modify: `e2e/friends.spec.ts`
- Create: `e2e/notifications.spec.ts`

**Interfaces:**

- Consumes: `ToastProvider` from `app/components/Toast/ToastProvider.tsx` and `useFriendRequestNotifications` from `app/hooks/useFriendRequestNotifications.ts` (Task 2).

- [ ] **Step 1: Add the nav badge to `Navbar`**

Modify `app/components/Navbar/Navbar.module.css` — add, after the existing `.navLink.active` rule:

```css
.badge {
  @apply inline-flex
    items-center
    justify-center
    ml-1.5
    min-w-[18px]
    h-[18px]
    px-1
    rounded-full
    text-xs
    font-semibold
    text-white
    bg-[var(--color-danger)];
}
```

Modify `app/components/Navbar/Navbar.tsx` — change the function signature from:

```tsx
export default function Navbar() {
```

to:

```tsx
export default function Navbar({
  pendingRequestCount = 0,
}: {
  pendingRequestCount?: number;
}) {
```

And change the nav-links render block from:

```tsx
<div className={styles.nav}>
  {NAV_LINKS.map(({ href, label }) => (
    <Link
      key={href}
      href={href}
      className={`${styles.navLink} ${pathname.startsWith(href) ? styles.active : ''}`}
    >
      {label}
    </Link>
  ))}
</div>
```

to:

```tsx
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
```

- [ ] **Step 2: Mount the toast provider and the hook in the shell layout**

Read the current `app/(shell)/layout.tsx` first — it's currently a Server Component. Replace its entire contents with:

```tsx
'use client';

import Navbar from '../components/Navbar/Navbar';
import { ToastProvider } from '../components/Toast/ToastProvider';
import { useFriendRequestNotifications } from '../hooks/useFriendRequestNotifications';
import styles from './layout.module.css';

function ShellContent({ children }: { children: React.ReactNode }) {
  const pendingRequestCount = useFriendRequestNotifications();
  return (
    <div className={styles.shell}>
      <Navbar pendingRequestCount={pendingRequestCount} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ShellContent>{children}</ShellContent>
    </ToastProvider>
  );
}
```

(`useFriendRequestNotifications` calls `useToast()` internally, which requires being rendered inside `<ToastProvider>` — this is why the hook call is in a separate inner component, not directly inside `ShellLayout` alongside the `<ToastProvider>` tag itself.)

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Fix the e2e fixture regression risk**

Read `e2e/helpers.ts` first. Change the `FRIENDS` array's third entry (id `'friend-3'`, Carol) from:

```ts
  {
    id: 'friend-3',
    name: 'Carol',
    nodeId: null,
    address: '10.0.0.4',
    port: 7734,
    status: 'INCOMING_PENDING',
    addedAt: '2024-03-01T00:00:00.000Z',
    acceptedAt: null,
    updatedAt: '2024-03-01T00:00:00.000Z',
    online: false,
    downloads: { count: 0, totalSize: '0' },
    uploads: { count: 0, totalSize: '0' },
  },
];
```

to:

```ts
  {
    id: 'friend-3',
    name: 'Carol',
    nodeId: 'node-carol',
    address: '10.0.0.4',
    port: 7734,
    status: 'ACCEPTED',
    addedAt: '2024-03-01T00:00:00.000Z',
    acceptedAt: '2024-03-01T01:00:00.000Z',
    updatedAt: '2024-03-01T01:00:00.000Z',
    online: false,
    downloads: { count: 0, totalSize: '0' },
    uploads: { count: 0, totalSize: '0' },
  },
];

// A variant of FRIENDS where Carol is an incoming pending request instead of
// an accepted friend — used only by tests that specifically exercise the
// incoming-request flow (friends.spec.ts) or the friend-request
// notification feature (notifications.spec.ts). Kept separate from the
// default FRIENDS fixture so the rest of the e2e suite (which uses
// mockBaseApp's default) doesn't incidentally trigger a friend-request
// notification/toast on every page.
export const FRIENDS_WITH_INCOMING_REQUEST = FRIENDS.map((f) =>
  f.id === 'friend-3'
    ? { ...f, nodeId: null, status: 'INCOMING_PENDING' as const, acceptedAt: null }
    : f,
);
```

- [ ] **Step 5: Update `friends.spec.ts` to use the new fixture where needed**

Read `e2e/friends.spec.ts` first. Change the import line from:

```ts
import { FRIENDS, mockBaseApp, mockFriends } from './helpers';
```

to:

```ts
import { FRIENDS, FRIENDS_WITH_INCOMING_REQUEST, mockBaseApp, mockFriends } from './helpers';
```

Change the `'shows incoming pending request with accept and decline buttons'` test from:

```ts
test('shows incoming pending request with accept and decline buttons', async ({ page }) => {
  await page.goto('/friends');
  await expect(page.getByText('Carol')).toBeVisible();
  await expect(page.getByRole('button', { name: /accept/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /decline/i }).first()).toBeVisible();
});
```

to:

```ts
test('shows incoming pending request with accept and decline buttons', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);
  await page.goto('/friends');
  await expect(page.getByText('Carol')).toBeVisible();
  await expect(page.getByRole('button', { name: /accept/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /decline/i }).first()).toBeVisible();
});
```

Change the `'accepting a friend request calls the API and refreshes'` test from:

```ts
test('accepting a friend request calls the API and refreshes', async ({ page }) => {
  const accepted = { ...FRIENDS[2], status: 'ACCEPTED', acceptedAt: new Date().toISOString() };
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') return route.fulfill({ json: accepted });
    return route.continue();
  });
  // After accept, mock the refresh returning updated list
  let callCount = 0;
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      callCount++;
      const list = callCount === 1 ? FRIENDS : [...FRIENDS.slice(0, 2), accepted];
      return route.fulfill({ json: list });
    }
    return route.continue();
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /accept/i })
    .first()
    .click();
  // Carol should no longer show accept/reject buttons after accepting
  await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(0);
});
```

to:

```ts
test('accepting a friend request calls the API and refreshes', async ({ page }) => {
  const accepted = { ...FRIENDS[2], status: 'ACCEPTED', acceptedAt: new Date().toISOString() };
  let hasAccepted = false;
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') {
      hasAccepted = true;
      return route.fulfill({ json: accepted });
    }
    return route.continue();
  });
  // Key off whether the PUT actually happened, not a raw GET call count —
  // the shell's own friend-request-notification poll and this page's poll
  // both hit this same route independently, so a naive counter can't tell
  // "before the user clicked" from "after".
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      const list = hasAccepted ? [...FRIENDS.slice(0, 2), accepted] : FRIENDS_WITH_INCOMING_REQUEST;
      return route.fulfill({ json: list });
    }
    return route.continue();
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /accept/i })
    .first()
    .click();
  // Carol should no longer show accept/reject buttons after accepting
  await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(0);
});
```

Change the `'rejecting a friend request removes them from the list'` test from:

```ts
test('rejecting a friend request removes them from the list', async ({ page }) => {
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 200, body: '' });
    return route.continue();
  });
  let callCount = 0;
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      callCount++;
      const list = callCount === 1 ? FRIENDS : FRIENDS.slice(0, 2);
      return route.fulfill({ json: list });
    }
    return route.continue();
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /decline/i })
    .first()
    .click();
  await expect(page.getByText('Carol')).not.toBeVisible();
});
```

to:

```ts
test('rejecting a friend request removes them from the list', async ({ page }) => {
  let hasRejected = false;
  await page.route('/api/friends/friend-3', (route) => {
    if (route.request().method() === 'PUT') {
      hasRejected = true;
      return route.fulfill({ status: 200, body: '' });
    }
    return route.continue();
  });
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      const list = hasRejected ? FRIENDS.slice(0, 2) : FRIENDS_WITH_INCOMING_REQUEST;
      return route.fulfill({ json: list });
    }
    return route.continue();
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /decline/i })
    .first()
    .click();
  await expect(page.getByText('Carol')).not.toBeVisible();
});
```

- [ ] **Step 6: Run the full Playwright suite to confirm the fixture fix works and nothing regressed**

Run: `bunx playwright test`
Expected: PASS — every existing spec file, 0 failures. Pay particular attention to `friends.spec.ts` (the 3 changed tests) and a couple of unrelated spec files (e.g. `chat.spec.ts`, `search.spec.ts`) to confirm no stray toast/badge interference now that `mockBaseApp`'s default `FRIENDS` no longer has an incoming-pending entry.

- [ ] **Step 7: Write the failing e2e test for the new feature**

Create `e2e/notifications.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';

import { FRIENDS, FRIENDS_WITH_INCOMING_REQUEST, mockBaseApp, mockFriends } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('shows a toast and a nav badge when an incoming friend request appears', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);

  // Navigate to a page that has nothing to do with Friends, to prove this
  // works globally, not just on the Friends page itself.
  await page.goto('/home');

  await expect(page.getByText('Carol wants to be your friend')).toBeVisible();
  await expect(page.getByRole('link', { name: /friends/i }).getByText('1')).toBeVisible();
});

test('does not show a toast when there are no incoming pending requests', async ({ page }) => {
  await mockFriends(page, FRIENDS);
  await page.goto('/home');
  await page.waitForTimeout(500);
  await expect(page.getByText(/wants to be your friend/i)).toHaveCount(0);
});

test('the toast auto-dismisses', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);
  await page.goto('/home');
  await expect(page.getByText('Carol wants to be your friend')).toBeVisible();
  await expect(page.getByText('Carol wants to be your friend')).not.toBeVisible({ timeout: 7_000 });
});

test('does not re-notify for a request already seen in this browser', async ({ page }) => {
  await mockFriends(page, FRIENDS_WITH_INCOMING_REQUEST);
  await page.goto('/home');
  await expect(page.getByText('Carol wants to be your friend')).toBeVisible();
  await expect(page.getByText('Carol wants to be your friend')).not.toBeVisible({ timeout: 7_000 });

  // Reload — same browser context, same localStorage. The poll fires again
  // on mount; Carol must not be re-notified.
  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.getByText('Carol wants to be your friend')).toHaveCount(0);
  // The badge, however, is derived fresh from the poll every time and
  // should still reflect the still-pending request.
  await expect(page.getByRole('link', { name: /friends/i }).getByText('1')).toBeVisible();
});
```

- [ ] **Step 8: Run the new tests to verify they fail**

Run: `bunx playwright test e2e/notifications.spec.ts`
Expected: FAIL — no toast/badge exists yet in the rendered output (Steps 1-2 of this task must not be skipped for this to be a real RED; if you're doing Steps in order, Steps 1-2 already happened, so instead run this against a git stash of those changes, or simply trust that the assertions fail without them — see note below).

> Note: unlike Tasks 1-2, this task's Steps 1-2 (the actual UI wiring) come _before_ this test in the step order, because the test needs the badge/toast rendering code to exist to be meaningful to write against real selectors. If you want a true RED, temporarily comment out the `<ToastProvider>`/hook wiring in `app/(shell)/layout.tsx`, confirm this test fails, then restore it. Otherwise, proceed straight to Step 9 and treat "did these assertions ever fail during development" as satisfied by having written them against the real UI as you built it.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bunx playwright test e2e/notifications.spec.ts`
Expected: PASS — 4 tests, 0 fail.

- [ ] **Step 10: Run the full Playwright suite once more**

Run: `bunx playwright test`
Expected: PASS — every spec file, 0 failures.

- [ ] **Step 11: Lint, format, and commit**

Run: `bunx eslint --max-warnings=0 app/components/Navbar/Navbar.tsx app/(shell)/layout.tsx e2e/helpers.ts e2e/friends.spec.ts e2e/notifications.spec.ts && bunx prettier --check app/components/Navbar/Navbar.tsx app/components/Navbar/Navbar.module.css "app/(shell)/layout.tsx" e2e/helpers.ts e2e/friends.spec.ts e2e/notifications.spec.ts`
Expected: no errors. Fix formatting with `bunx prettier --write <path>` and re-check.

```bash
git add app/components/Navbar/Navbar.tsx app/components/Navbar/Navbar.module.css "app/(shell)/layout.tsx" e2e/helpers.ts e2e/friends.spec.ts e2e/notifications.spec.ts
git commit -m "feat(notifications): wire toast/badge into the shell, fix e2e fixture regression risk"
```

---

### Task 4: Settings page — desktop notification permission section

**Files:**

- Modify: `app/(shell)/settings/SettingsView.tsx`
- Modify: `e2e/settings.spec.ts`

**Interfaces:**

- Consumes: `getNotificationPermission`, `requestNotificationPermission`, `NotificationPermissionState` from `app/lib/notifications.ts` (Task 1).

This task has no `bun:test` (it's a page section, verified via Playwright) and no separate RED/GREEN cycle in the usual sense — write the component, then write and run the e2e tests that exercise all four permission states.

- [ ] **Step 1: Add the Notifications section to Settings**

Read `app/(shell)/settings/SettingsView.tsx` first, in full — it's a single file with several `XSection()` function components following a shared `<Section title="...">` wrapper pattern, assembled at the bottom in `export default function SettingsView()`.

Add this import alongside the existing `../../lib/api` import block (after it):

```tsx
import {
  type NotificationPermissionState,
  getNotificationPermission,
  requestNotificationPermission,
} from '../../lib/notifications';
```

Add this new section function, placed after `MaintenanceSection` (before the `// ── Root component ──` comment):

```tsx
// ── Notifications section ───────────────────────────────────────────────────

function NotificationsSection() {
  const [permission, setPermission] = useState<NotificationPermissionState>('unsupported');

  useEffect(() => {
    setPermission(getNotificationPermission());
  }, []);

  async function handleEnable() {
    const result = await requestNotificationPermission();
    setPermission(result);
  }

  return (
    <Section title="Notifications">
      <div className={styles.form}>
        {permission === 'unsupported' && (
          <p className={styles.hint}>
            Desktop notifications aren&apos;t supported in this browser.
          </p>
        )}
        {permission === 'granted' && (
          <p className={styles.hint}>Desktop notifications are enabled.</p>
        )}
        {permission === 'denied' && (
          <p className={styles.hint}>
            Desktop notifications are blocked. Check your browser&apos;s site settings to enable
            them.
          </p>
        )}
        {permission === 'default' && (
          <div className={styles.formFooter}>
            <button type="button" className="btn btn-primary" onClick={handleEnable}>
              Enable desktop notifications
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
```

Add `<NotificationsSection />` to the render list in `export default function SettingsView()`, after `<MaintenanceSection />`:

```tsx
      <ProfileSection initial={settings} />
      <PrivacySection initial={settings} />
      <FilesSection initial={settings} envConfig={envConfig} />
      <NetworkingSection initial={settings} />
      <ScriptsSection />
      <MaintenanceSection />
      <NotificationsSection />
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Write the e2e tests**

Append to `e2e/settings.spec.ts` (no new imports needed — `mockBaseApp` is already imported):

```typescript
test('shows enable button when notification permission is default', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'default';
      static requestPermission = async () => 'granted';
    };
  });
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: /enable desktop notifications/i })).toBeVisible();
});

test('shows an enabled message when notification permission is granted', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
    };
  });
  await page.goto('/settings');
  await expect(page.getByText(/desktop notifications are enabled/i)).toBeVisible();
});

test('shows a blocked message when notification permission is denied', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'denied';
      static requestPermission = async () => 'denied';
    };
  });
  await page.goto('/settings');
  await expect(page.getByText(/desktop notifications are blocked/i)).toBeVisible();
});

test('shows an unsupported message when the Notification API is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = undefined;
  });
  await page.goto('/settings');
  await expect(page.getByText(/not supported/i)).toBeVisible();
});

test('clicking enable requests permission and updates the UI', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).Notification = class {
      static permission = 'default';
      static requestPermission = async () => 'granted';
    };
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: /enable desktop notifications/i }).click();
  await expect(page.getByText(/desktop notifications are enabled/i)).toBeVisible();
});
```

- [ ] **Step 4: Run the new tests**

Run: `bunx playwright test e2e/settings.spec.ts`
Expected: PASS — all tests in this file, including the 5 new ones (0 fail).

- [ ] **Step 5: Run the full Playwright suite once more**

Run: `bunx playwright test`
Expected: PASS — every spec file, 0 failures.

- [ ] **Step 6: Run the full `bun:test` suite once more (nothing here should be affected, but confirm)**

Run: `bun run test`
Expected: PASS — 0 fail.

- [ ] **Step 7: Lint, format, and commit**

Run: `bunx eslint --max-warnings=0 "app/(shell)/settings/SettingsView.tsx" e2e/settings.spec.ts && bunx prettier --check "app/(shell)/settings/SettingsView.tsx" e2e/settings.spec.ts`
Expected: no errors. Fix formatting with `bunx prettier --write <path>` and re-check.

```bash
git add "app/(shell)/settings/SettingsView.tsx" e2e/settings.spec.ts
git commit -m "feat(notifications): add desktop notification permission section to Settings"
```

---

## Self-Review Notes

- **Spec coverage:** desktop notification with toast fallback (Tasks 1-2), nav badge (Task 3), permission flow in Settings (Task 4), localStorage-based dedup (Task 2 + verified in Task 3's e2e test), silent-retry error handling matching the existing Friends-page convention (Task 2), pure-function unit test for the diffing logic (Task 2 Step 1-4) — every spec section has a corresponding task.
- **Placeholder scan:** no TBD/TODO markers; every step has complete, runnable code or an exact command. Task 3's Step 8 note is an honest process caveat (not a placeholder) about what "RED" means for an integration-style e2e test written alongside its own UI code, mirroring how the release-workflow plan handled its own no-automated-test workflow-YAML task.
- **Type consistency:** `NotificationPermissionState`, `getNotificationPermission`, `requestNotificationPermission`, `showDesktopNotification` (Task 1) are used identically in Task 2 (the hook) and Task 4 (Settings). `getNewlyPendingIds(pendingIds: string[], notifiedIds: Set<string>): string[]` (Task 2) matches its only call site inside `useFriendRequestNotifications`. `useToast()`/`ToastProvider` (Task 2) match their mounting in Task 3. `FRIENDS_WITH_INCOMING_REQUEST` (Task 3) is used consistently across `friends.spec.ts` and `notifications.spec.ts`.
- **Regression risk called out explicitly:** Task 3 documents and fixes both the shared-fixture toast pollution risk and the dual-poller `callCount` race in the two `friends.spec.ts` tests that needed rewriting — these would otherwise have surfaced as confusing, hard-to-reproduce flakiness discovered well after this feature shipped, not as a clean task-level review finding.
