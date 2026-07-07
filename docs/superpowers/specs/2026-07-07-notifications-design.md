# Notifications (Incoming Friend Requests) — Design

## Goal

Notify the user when a friend request arrives, without them having to be on
the Friends page to notice. Desktop notification preferred (works even when
the tab isn't focused), with an in-app toast fallback so it's never silently
missed if permission is denied or unsupported. This is the first
"Notifications" TODO sub-item; "when updates are ready to install" is
explicitly deferred until the auto-update mechanism exists to fire it (see
Scope below).

## Current state

- `app/(shell)/friends/page.tsx` already polls `getFriends()` every 5s
  (`POLL_MS = 5_000`) and locally filters `friends.filter(f => f.status ===
'INCOMING_PENDING')` to render an "Incoming requests" section. This only
  updates while the user is actually on `/friends`.
- No toast, badge, or desktop-notification code exists anywhere in the app
  today (`grep` for `toast`/`Notification(` in `app/` returns nothing).
- `app/components/Navbar/Navbar.tsx` renders static nav links with no badge
  support.
- `app/(shell)/layout.tsx` wraps every shell page (`Navbar` + `{children}`)
  — the natural place to mount something that must persist across page
  navigation.
- No shared/global client state pattern exists in this codebase — every
  page (`Chat`, `Friends`, `Transfers`) polls its own data independently in
  its own `useEffect`/`setTimeout` loop. This project stays consistent with
  that pattern here rather than introducing a new one.
- Browsers require `Notification.requestPermission()` to be called from a
  direct user-gesture handler (a real click) — it cannot be requested from
  a timer/poll callback. The Settings page already hosts several toggles
  (auto-accept, invite password, etc.) and is the natural place for an
  explicit "Enable desktop notifications" action.

## Architecture

A single polling hook, mounted once in the shell layout — not a shared
data store. Considered and rejected:

- **Shared `FriendsProvider` context**, refactoring `FriendsPage` to consume
  it instead of polling itself (avoids one duplicate poll). Rejected:
  introduces a global-state pattern that doesn't exist anywhere else in
  this codebase, and touches working, tested code for marginal benefit.
- **Server push (WebSocket/SSE)** so the server tells the browser the
  instant a request arrives. Rejected: this app has zero server-push
  infrastructure today, and a friend request isn't remotely latency
  sensitive — 5s poll latency is entirely acceptable. Over-scoped for the
  need.

## Components

- `app/lib/notifications.ts` — new module:
  - `getNotificationPermission(): NotificationPermission | 'unsupported'`
  - `requestNotificationPermission(): Promise<NotificationPermission>` —
    thin wrapper around `Notification.requestPermission()`; must only be
    called from a real click handler.
  - `notify(title: string, body: string, onClick?: () => void): void` —
    fires a real `Notification` if permission is `'granted'`; otherwise
    calls the toast fallback (via the toast context, see below).
- `app/components/Toast/ToastProvider.tsx` — new: React context (`useToast()`
  returning `{ show(message: string): void }`) + `<ToastContainer />`
  rendering currently-active toasts, auto-dismissing each after ~5s. This
  is the one unavoidable piece of shared state this feature needs — a
  toast must render regardless of which page you're currently on, which
  requires something mounted at the shell level. It is scoped narrowly (a
  list of ephemeral messages), not a general app-data store, so it doesn't
  conflict with the "no shared data context" decision above.
- `app/components/Toast/Toast.module.css` — styling, following existing CSS
  module conventions (global CSS variables from `app/globals.css`).
- `app/hooks/useFriendRequestNotifications.ts` — new hook, mounted once in
  `app/(shell)/layout.tsx`:
  - Polls `getFriends()` every 5s (same interval/pattern as
    `FriendsPage`), silently retrying on failure exactly like that page
    does.
  - Filters to `INCOMING_PENDING`.
  - Reads/writes a `localStorage` key (e.g.
    `filenet:notifiedFriendRequestIds`) holding a JSON array of friend IDs
    already notified about, so a still-pending request isn't re-notified
    on every subsequent poll.
  - For each `INCOMING_PENDING` friend whose id isn't yet in that set:
    calls `notify('New friend request', \`${f.name} wants to be your
    friend\`, () => { window.focus(); window.location.href = '/friends'; })`,
    then adds the id to the localStorage set.
  - Returns the current incoming-pending count (for the nav badge) —
    purely derived from the same poll response, no extra request.
- `app/(shell)/layout.tsx` — calls the hook, passes the returned count down
  to `<Navbar pendingRequestCount={count} />`, and mounts
  `<ToastProvider>` wrapping the existing `<Navbar />` + `<main>{children}</main>`.
- `app/components/Navbar/Navbar.tsx` — accepts `pendingRequestCount?: number`
  prop; renders a small badge next to the "Friends" link when count > 0.
- `app/(shell)/settings/page.tsx` — new "Notifications" section: shows
  current permission state (`default` / `granted` / `denied` /
  `unsupported`) and an "Enable desktop notifications" button, visible only
  when state is `default`. When `denied`, show a short note that the
  browser's site settings must be changed manually (there is no
  programmatic way to re-prompt once denied).

## Data Flow

```
shell layout mounts
  → useFriendRequestNotifications hook starts polling (5s)
  → poll returns friends list
  → filter INCOMING_PENDING
  → diff against localStorage "notified" set
  → for each new id:
      notify() → Notification if granted, else toast.show()
      record id in localStorage
  → hook returns count → Navbar renders badge
```

Accepting or declining a request (already implemented in `FriendsPage`)
removes it from the `INCOMING_PENDING` set on the next poll from either
page, which naturally clears the badge — no extra bookkeeping needed. The
localStorage "notified" entry for that id becomes irrelevant (harmless
stale entry; never cleaned up, but the set only grows by one entry per
friend request ever received, which is not a realistic size concern for a
personal app).

## Error Handling

Matches the existing Friends-page convention exactly: poll failures are
silent and retried on the next tick — a transient network blip must not
spam a toast or otherwise interrupt the user. `localStorage` reads/writes
are wrapped defensively (a corrupted or missing value is treated as an
empty set, never thrown).

## Testing

- Playwright (`e2e/notifications.spec.ts`, new): mock `/api/friends` to
  return an `INCOMING_PENDING` friend, verify the in-app toast fallback
  appears and the Navbar badge shows the correct count. The real
  `Notification` API path itself isn't exercised by Playwright (headless
  Chromium doesn't surface OS notification chrome, and permission is
  `default`/blocked in automated contexts by design) — that path is
  verified by manual testing in a real browser before calling the feature
  done, per this project's UI-verification convention.
- `bun:test` unit test for the pure "which ids are new" diffing logic
  (input: current `INCOMING_PENDING` ids + previously-notified ids;
  output: which ids to notify about now) — this is the one piece of real
  business logic in the hook and is cleanly extractable as a pure
  function, separate from the `localStorage`/polling I/O around it.

## Scope

**In scope:** desktop notification (with permission flow) + in-app toast
fallback + nav badge, for incoming friend requests only.

**Out of scope (explicitly deferred):**

- "When updates are ready to install" notification — no event source
  exists yet; wire this in as a follow-up once the auto-update mechanism
  is built, reusing the `notify()`/toast infrastructure from this feature.
- Any other notification source ("Other things?" in the TODO) — not
  specified, not built.
- Notification preferences (e.g. muting, quiet hours) — no complexity like
  this is warranted for a single notification source.
- Mobile/PWA push notifications (requires a service worker + push
  subscription backend) — this app has no service worker today and this
  is a substantially larger feature; the Web `Notification` API covers the
  desktop-browser-tab case this spec targets.
