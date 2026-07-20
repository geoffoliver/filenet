# Initiate DM Conversations — Design

## Context

TODO.md's Chat section has one remaining item: "Give users a way to initiate DM
conversations." Today, `app/(shell)/chat/ChatView.tsx`'s empty state literally says
_"Create a group or send a DM from a friend's profile"_ — but no such affordance
exists on the Friends page. There's no way to start a DM at all today; conversations
only appear in Chat if a peer messages you first (via inbound `chat-message` upsert).

The backend and API client are already fully built and unused:

- `POST /api/conversations` with `{ peerNodeId }` (`server/management.ts:687-724`)
  validates the peer is an `ACCEPTED` friend (403 otherwise), creates the `DM`
  conversation row if it doesn't already exist (`onConflictDoNothing`, keyed by the
  canonical `dm:{nodeA}:{nodeB}` id), and returns it — fully covered by existing Jest
  tests in `server/__tests__/management.test.ts` (lines ~1685-1811).
- `openDmConversation(peerNodeId)` in `app/lib/api.ts:467` calls that endpoint and is
  never referenced anywhere in the UI.

So this is a frontend-only change: wire an entry point to plumbing that already works.

## Goals

- A "Message" button on each accepted friend's row on the Friends page.
- Clicking it creates (or reuses) the DM conversation and navigates to Chat with that
  conversation selected and its message thread visible.
- Loading and error states consistent with the Friends page's existing per-row action
  conventions (`actionId`, inline error text).

## Non-goals

- No new backend/API — `openDmConversation` and its endpoint are used as-is.
- No entry point from the Chat sidebar itself (e.g. a "+ New DM" picker) — out of
  scope per product decision; Friends page is the only entry point.
- No store-and-forward/notification to the peer when a DM is opened with no message
  sent yet — matches existing group-chat semantics (see `project_filenet_chat_architecture`
  memory): the conversation is local-only until the first message is actually sent.

## Flow

1. **Friends page** (`app/(shell)/friends/page.tsx`): each row in the "Friends"
   (`accepted`) section gets a "Message" button in the `actions` div, before "Remove".
   `onClick` calls a new `handleMessage(friend)`:
   - Sets `actionId = friend.id` (reusing the existing loading-state field, same as
     Accept/Reject/Remove).
   - Calls `openDmConversation(friend.nodeId!)` (accepted friends always have
     `nodeId` set, per "Persist friend's node ID and public key once connected").
   - On success: `router.push('/chat?conv=' + encodeURIComponent(conv.id))`.
   - On failure: set a new per-row error state (mirrors `formError`, e.g.
     `messageError: Record<string, string>` keyed by friend id) and clear `actionId`
     so the button re-enables for retry. Error text renders under that friend's row,
     same visual treatment as the Add Friend form's `formError`.
   - Requires converting `friends/page.tsx` to use `useRouter` from `next/navigation`
     (not currently imported there).

2. **Chat route** (`app/(shell)/chat/page.tsx` + `ChatView.tsx`): needs to read a
   `conv` query param, which requires `useSearchParams()` — under Next's static
   export (`output: 'export'`, per CLAUDE.md), any component calling that hook must
   sit under a `<Suspense>` boundary. `page.tsx` is currently a server component with
   a static `metadata` export (`title: 'Chat — Filenet'`); wrapping the existing
   `<ChatView />` in `<Suspense>` there keeps the metadata export intact (no need for
   the client-wrapper-plus-remount-key trick `search/page.tsx` uses — Chat doesn't
   need to remount on param change, just a one-time initial read):

   ```tsx
   export default function ChatPage() {
     return (
       <Suspense>
         <ChatView />
       </Suspense>
     );
   }
   ```

3. **Inside `ChatView`**: a new effect reads `useSearchParams().get('conv')` once on
   mount. When that id is present in the (polled) `conversations` list, call the
   existing `selectConv(id)`, then `router.replace('/chat')` to strip the query param
   — so a later refresh or back-navigation doesn't re-trigger the deep link. (Harmless
   if it did — `selectConv` no-ops when already active — but stripping keeps the URL
   clean.) If the id never shows up (edge case: friend removed between click and page
   load), it's a silent no-op, consistent with `ChatView`'s existing silent-retry poll
   error handling.

## Error handling

- Friends page: inline error text per-row, same convention as `formError`, clears on
  next attempt. No toast — `ToastProvider`/`useToast` exist in the codebase but are
  currently unused everywhere outside their own definition, so introducing them for
  this one button would be inconsistent with established patterns.
- Chat page: no explicit error UI for a missing/stale `conv` param — it's an edge
  case with no user-visible action to retry (the user already navigated away from
  Friends), and silently landing on the normal conversation list is an acceptable
  fallback.

## Code impact

- `app/(shell)/friends/page.tsx`: import `useRouter` and `openDmConversation`; add
  `handleMessage`; add `messageError` state; add the "Message" button + inline error
  markup to the accepted-friends row.
- `app/(shell)/friends/friends.module.css`: no new classes expected — reuse existing
  `.actions`/button/error styles; add one only if the error text needs distinct
  placement from `formError`.
- `app/(shell)/chat/page.tsx`: wrap `<ChatView />` in `<Suspense>`.
- `app/(shell)/chat/ChatView.tsx`: import `useRouter`/`useSearchParams`; add the
  mount effect described above.

## Testing

- Playwright (`e2e/friends.spec.ts` or wherever Friends coverage lives): clicking
  "Message" on an accepted friend (mock `POST /api/conversations` and
  `GET /api/conversations`) navigates to `/chat`, and the DM conversation is shown
  active with its thread visible. Also cover the failure path (mock a non-2xx
  response) showing the inline error and re-enabling the button.
- No new backend/Jest coverage needed — the `peerNodeId` branch of
  `POST /api/conversations` is already fully tested.

## Workflow

- Built on `feature/initiate-dm`, per project convention (feature branch → PR →
  Copilot review → merge).
- Update `CHANGELOG.md`'s `[Unreleased]` section.
- Update `TODO.md` to check off "Give users a way to initiate DM conversations."
