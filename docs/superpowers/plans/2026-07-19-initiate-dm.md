# Initiate DM Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user start a DM with an accepted friend from the Friends page — closing the last open item under Chat in TODO.md ("Give users a way to initiate DM conversations").

**Architecture:** Both the backend endpoint (`POST /api/conversations` with `{ peerNodeId }`) and the frontend API client (`openDmConversation`) already exist, fully tested, and are simply unused. This plan wires a "Message" button into `app/(shell)/friends/page.tsx` that calls `openDmConversation` and navigates to `/chat?conv=<id>`, then teaches `app/(shell)/chat/ChatView.tsx` to read that `conv` query param on load, select the matching conversation once it appears in its polled list, and strip the param from the URL.

**Tech Stack:** Next.js 16 (client components, `next/navigation`), Tailwind v4 via CSS Modules, Playwright for e2e coverage. No backend or `app/lib/api.ts` changes.

## Global Constraints

- No backend/API changes — `openDmConversation` and `POST /api/conversations` are used as-is (spec: Goals/Non-goals).
- Friends page is the only entry point — no Chat-sidebar "+ New DM" picker (spec: Non-goals).
- Accepted friends always have `nodeId` set ("Persist friend's node ID and public key once connected" — TODO.md, Friends section), so `handleMessage` does not need a null-check/fallback path for a missing `nodeId` (spec: Flow, step 1).
- Errors from starting a DM render as inline text per-friend-row, matching the existing `formError` convention in `app/(shell)/friends/friends.module.css` — no toast (`ToastProvider`/`useToast` exist but are unused everywhere in the codebase outside their own definition, so introducing them here would be inconsistent) (spec: Error handling).
- `app/(shell)/chat/page.tsx` keeps its static `metadata` export (`title: 'Chat — Filenet'`) — wrap `<ChatView />` in `<Suspense>` rather than converting the page to a client component (spec: Flow, step 3).
- `react-hooks/exhaustive-deps` is an ESLint **error**-level rule (`eslint.config.*:40`) — every effect's dependency array must be complete; `ChatView.tsx`'s `selectConv` must become a `useCallback` so the new deep-link effect can depend on it safely.
- Work happens on the `feature/initiate-dm` branch (already created, spec doc committed there) — PR + Copilot review before merging to `master`, per project convention.
- Pre-commit hooks run Prettier + ESLint via lint-staged/husky on staged files — every commit must pass them.
- `bun run test` (backend + `app/lib`/`app/hooks` unit tests) and `bun run test:e2e` (`bunx playwright test`) must both stay green.

---

## File Structure

- `app/(shell)/friends/page.tsx` — **modified.** Add `useRouter`, `openDmConversation` import, `messageError` state, `handleMessage`, and the "Message" button + inline error markup in the accepted-friends row.
- `app/(shell)/friends/friends.module.css` — **modified.** New `.actionGroup` / `.actionError` classes.
- `e2e/friends.spec.ts` — **modified.** New tests for the happy path and the failure path.
- `app/(shell)/chat/page.tsx` — **modified.** Wrap `<ChatView />` in `<Suspense>`.
- `app/(shell)/chat/ChatView.tsx` — **modified.** `selectConv` becomes a `useCallback`; new effect reads the `conv` search param, selects the conversation once present, then strips the param via `router.replace('/chat')`.
- `e2e/chat.spec.ts` — **modified.** New test for the deep-link behavior.
- `CHANGELOG.md` — **modified.** New `### Added` bullet under `[Unreleased]`.
- `TODO.md` — **modified.** Check off "Give users a way to initiate DM conversations."

---

### Task 1: "Message" button on the Friends page

**Files:**

- Modify: `app/(shell)/friends/page.tsx`
- Modify: `app/(shell)/friends/friends.module.css`
- Modify: `e2e/friends.spec.ts`

**Interfaces:**

- Consumes: `openDmConversation(peerNodeId: string): Promise<Conversation>` (`app/lib/api.ts:467`, already exists — no changes).
- Produces (consumed by Task 2 only via the URL contract, not a code import): navigation to `/chat?conv=<encodeURIComponent(conversationId)>` on success.

This task is independently testable: after it, clicking "Message" posts the right body and lands on `/chat` with the id in the query string. Task 2 (Chat actually reading that param) is a separate, separately-reviewable concern.

- [ ] **Step 1: Add failing e2e tests**

Add to `e2e/friends.spec.ts`, after the existing `'shows remove button and prompts confirmation'` test:

```typescript
test('starting a DM posts peerNodeId and navigates to Chat with it in the URL', async ({
  page,
}) => {
  let posted: unknown;
  await page.route('/api/conversations', (route) => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON();
      return route.fulfill({
        json: {
          id: 'dm:node-alice:self',
          type: 'DM',
          name: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          messages: [],
        },
      });
    }
    return route.fulfill({ json: FRIENDS });
  });

  await page.goto('/friends');
  await page
    .getByRole('button', { name: /^message$/i })
    .first()
    .click();

  await expect(page).toHaveURL(/\/chat\?conv=dm%3Anode-alice%3Aself/);
  expect((posted as { peerNodeId: string }).peerNodeId).toBe('node-alice');
});

test('shows an inline error and re-enables the button when starting a DM fails', async ({
  page,
}) => {
  await page.route('/api/conversations', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 403, body: 'peerNodeId must be an accepted friend' });
    }
    return route.fulfill({ json: FRIENDS });
  });

  await page.goto('/friends');
  const messageBtn = page.getByRole('button', { name: /^message$/i }).first();
  await messageBtn.click();

  await expect(page.getByText('peerNodeId must be an accepted friend')).toBeVisible();
  await expect(messageBtn).toBeEnabled();
  await expect(page).toHaveURL(/\/friends$/);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bunx playwright test e2e/friends.spec.ts -g "starting a DM|inline error"`
Expected: FAIL — no "Message" button exists yet (`getByRole('button', { name: /^message$/i })` finds nothing).

- [ ] **Step 3: Add the `.actionGroup` / `.actionError` styles**

In `app/(shell)/friends/friends.module.css`, immediately after the existing `.confirmLabel` rule (around line 162), add:

```css
.actionGroup {
  @apply flex
    flex-col
    items-end
    gap-1;
}

.actionError {
  @apply text-xs
    text-[var(--color-danger)]
    text-right;
}
```

- [ ] **Step 4: Wire `handleMessage` and the button into `page.tsx`**

Change the imports at the top of `app/(shell)/friends/page.tsx`:

```typescript
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { AddFriendParams, Friend } from '../../lib/api';
import {
  acceptFriend,
  addFriend,
  formatBytes,
  getFriends,
  openDmConversation,
  rejectFriend,
  removeFriend,
} from '../../lib/api';

import styles from './friends.module.css';
```

Inside `FriendsPage`, add `router` and `messageError` state alongside the existing state declarations (after `const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);`):

```typescript
const router = useRouter();
const [messageError, setMessageError] = useState<Record<string, string>>({});
```

Add `handleMessage`, directly after `handleAccept`/before `handleReject` (or anywhere among the other handlers — placed here to keep the accept/message/reject/remove handlers grouped):

```typescript
async function handleMessage(friend: Friend) {
  setActionId(friend.id);
  setMessageError((prev) => ({ ...prev, [friend.id]: '' }));
  try {
    const conv = await openDmConversation(friend.nodeId as string);
    router.push(`/chat?conv=${encodeURIComponent(conv.id)}`);
  } catch (err) {
    setMessageError((prev) => ({
      ...prev,
      [friend.id]: err instanceof Error ? err.message : 'Failed to start conversation.',
    }));
  } finally {
    setActionId(null);
  }
}
```

In the accepted-friends `<ul>` block, replace the existing `<div className={styles.actions}>...</div>` (the one inside the `accepted.map` loop, currently just the confirm-remove/Remove button) with a version that adds the Message button first:

```tsx
<div className={styles.actions}>
  <div className={styles.actionGroup}>
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => handleMessage(f)}
      disabled={actionId === f.id}
    >
      {actionId === f.id ? '…' : 'Message'}
    </button>
    {messageError[f.id] && <span className={styles.actionError}>{messageError[f.id]}</span>}
  </div>
  {confirmRemoveId === f.id ? (
    <>
      <span className={styles.confirmLabel}>Remove?</span>
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => handleRemove(f.id)}
        disabled={actionId === f.id}
      >
        Yes
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setConfirmRemoveId(null)}>
        No
      </button>
    </>
  ) : (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => setConfirmRemoveId(f.id)}
      disabled={actionId === f.id}
    >
      Remove
    </button>
  )}
</div>
```

(This is the block currently at `app/(shell)/friends/page.tsx:349-379` — only the accepted-friends section's actions div, not the incoming/outgoing sections, which don't get a Message button since you can't DM a friend who isn't `ACCEPTED` yet.)

- [ ] **Step 5: Run the e2e friends suite to verify it passes**

Run: `bunx playwright test e2e/friends.spec.ts`
Expected: PASS — all tests green, including the two added in Step 1.

- [ ] **Step 6: Run format/lint checks and commit**

```bash
bun run format
bun run lint
git add app/\(shell\)/friends/page.tsx app/\(shell\)/friends/friends.module.css e2e/friends.spec.ts
git commit -m "feat: add Message button to start a DM from the Friends page"
```

---

### Task 2: Chat deep-links to a conversation via `?conv=`

**Files:**

- Modify: `app/(shell)/chat/page.tsx`
- Modify: `app/(shell)/chat/ChatView.tsx`
- Modify: `e2e/chat.spec.ts`

**Interfaces:**

- Consumes: the `/chat?conv=<id>` URL contract produced by Task 1 (no code-level dependency — this task is tested by navigating directly to that URL, independent of the Friends page).
- Produces: nothing consumed by later tasks — this is the last piece of the feature.

- [ ] **Step 1: Add a failing e2e test**

Add to `e2e/chat.spec.ts`, after the existing `'shows empty state when no conversation is selected'` test:

```typescript
test('opens the conversation from a ?conv= query param and clears it from the URL', async ({
  page,
}) => {
  await page.goto('/chat?conv=dm:node-alice:self');

  const bubbles = page.locator('[class*="bubbleBody"]');
  await expect(bubbles.filter({ hasText: 'Hey there!' })).toBeVisible();
  await expect(bubbles.filter({ hasText: 'Hi Alice!' })).toBeVisible();
  await expect(page).toHaveURL(/\/chat$/);
});
```

(Uses the `dm:node-alice:self` fixture already in `CONVERSATIONS` and the `mockMessages(page, DM_ID)` call already in this file's `beforeEach` — no new mocks needed.)

- [ ] **Step 2: Run the new test to verify it fails**

Run: `bunx playwright test e2e/chat.spec.ts -g "conv= query param"`
Expected: FAIL — the message bubbles never appear because nothing reads the `conv` param yet.

- [ ] **Step 3: Wrap `ChatView` in `Suspense`**

Replace `app/(shell)/chat/page.tsx` with:

```tsx
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
```

- [ ] **Step 4: Turn `selectConv` into a `useCallback` and add the deep-link effect in `ChatView.tsx`**

Add to the imports at the top of `app/(shell)/chat/ChatView.tsx`:

```typescript
import { useRouter, useSearchParams } from 'next/navigation';
```

Inside `ChatView`, add `router`/`searchParams` alongside the other hooks near the top of the component body (after `const handleCloseNewGroup = useCallback(() => setShowNewGroup(false), []);`):

```typescript
const router = useRouter();
const searchParams = useSearchParams();
const pendingConvId = searchParams.get('conv');
```

Replace the existing `function selectConv(convId: string) { ... }` (currently `app/(shell)/chat/ChatView.tsx:212-219`) with a `useCallback` version, keeping it in the same place among the other handlers:

```typescript
const selectConv = useCallback(
  (convId: string) => {
    if (convId === activeConvId) return;
    activeConvIdRef.current = convId; // sync update so loadMessages guard doesn't race
    prevMsgCountRef.current = 0; // reset so first load always scrolls to bottom
    setActiveConvId(convId);
    setMessages([]);
    loadMessages(convId);
  },
  [activeConvId, loadMessages],
);
```

Add a new effect right after the "Only scroll to bottom when new messages arrive" effect (currently ending around `app/(shell)/chat/ChatView.tsx:210`):

```typescript
// Deep-link support: /chat?conv=<id> (e.g. from the Friends page's "Message"
// button). Waits for the target conversation to show up in the polled list
// before selecting it, then strips the param so refresh/back doesn't replay it.
useEffect(() => {
  if (!pendingConvId) return;
  if (!conversations.some((c) => c.id === pendingConvId)) return;
  selectConv(pendingConvId);
  router.replace('/chat');
}, [pendingConvId, conversations, router, selectConv]);
```

- [ ] **Step 5: Run the e2e chat suite to verify it passes**

Run: `bunx playwright test e2e/chat.spec.ts`
Expected: PASS — all tests green, including the one added in Step 1.

- [ ] **Step 6: Run the full e2e suite once to catch cross-page regressions**

Run: `bunx playwright test`
Expected: PASS — every spec file green (this change touches shared files/hooks used across the Chat and Friends views).

- [ ] **Step 7: Run format/lint checks and commit**

```bash
bun run format
bun run lint
git add app/\(shell\)/chat/page.tsx app/\(shell\)/chat/ChatView.tsx e2e/chat.spec.ts
git commit -m "feat: open a conversation from a /chat?conv= deep link"
```

---

### Task 3: Changelog, TODO, and final verification

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `TODO.md`

**Interfaces:** None — documentation-only task.

- [ ] **Step 1: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add (creating an `### Added` section if one doesn't already exist there):

```markdown
### Added

- **Start a DM from the Friends page** — each accepted friend now has a "Message" button that opens (or reuses) the DM conversation and jumps to Chat with it selected, via the existing `POST /api/conversations` `peerNodeId` endpoint that was previously unused from the UI.
```

- [ ] **Step 2: Update TODO.md**

In `TODO.md`, under `### Chat`, change:

```markdown
- [ ] Give users a way to initiate DM conversations
```

to:

```markdown
- [x] Give users a way to initiate DM conversations — "Message" button on each accepted friend's row (Friends page) calls the existing `openDmConversation`/`POST /api/conversations` (`peerNodeId`) and navigates to `/chat?conv=<id>`; `ChatView` selects it once it appears in the polled conversation list and strips the query param
```

- [ ] **Step 3: Run the full test suite one final time**

```bash
bun run test
bun run test:e2e
```

Expected: PASS — all backend/lib/hooks unit tests and all Playwright specs green.

- [ ] **Step 4: Run format/lint checks and commit**

```bash
bun run format
bun run lint
git add CHANGELOG.md TODO.md
git commit -m "docs: log Message-button DM initiation in CHANGELOG and TODO"
```
