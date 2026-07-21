# Streaming Search Results — Design

## Context

TODO.md's Infrastructure section has one open item: "Stream" in search results —
rather than waiting for all results to be delivered back to a client (which could
take a while on a large network) before displaying the results, display results as
soon as they are available and update the list as new results come in, with an
indicator that the search is still running.

Today `GET /api/search` (`server/management.ts`) awaits both `searchFiles()` (local,
synchronous DB query) and `initiateNetworkSearch()` (`server/search-protocol.ts`) via
`Promise.all`, then returns one JSON response. `initiateNetworkSearch` already
collects network results incrementally internally — each `handleSearchResult` call
appends a batch to `pending.results` and resets a 500ms "settle" timer, resolving
early once nothing new arrives for 500ms, once `MAX_NETWORK_RESULTS` (200) is hit, or
after the full `SEARCH_TIMEOUT_MS` (5s) — but only the final aggregate is ever exposed
to the caller. The frontend (`SearchView.tsx`) calls `searchFiles()` once and renders
nothing until that whole round-trip (up to 5s) completes.

So the underlying collection is already push-driven; this change exposes that
incrementally instead of buffering it all server-side until the very end.

## Goals

- Local results appear immediately (no waiting on the network fan-out).
- Network results appear incrementally, batch by batch, as peers respond.
- A visible indicator shows the search is still in progress, and clears when done.
- No change to the existing result cap, TTL, dedup, or per-sender flood protection in
  `search-protocol.ts` — this only changes how/when results already being collected
  are surfaced to the client.

## Non-goals

- No change to the P2P wire protocol (`search-request`/`search-result` messages
  between nodes) — streaming is purely between the local UI and its own server.
- No WebSocket channel between browser and local server — SSE is one-directional,
  which is all this needs, and needs no new client-server handshake infrastructure.
- No retry/reconnect logic for the SSE stream — a search is a single bounded
  operation (max 5s); if the connection drops, the user just searches again, same as
  a failed fetch today.

## Architecture

New endpoint `GET /api/search/stream` (SSE), replacing the network-search
functionality of `GET /api/search` entirely (see "Code impact" — `/api/search` becomes
local-only). Accepts `q` and `type` (same validation as today, via
`SearchQuerySchema` minus `network`/`limit`/`offset` — streaming search always runs
with the existing fixed local limit of 50, matching current network-search behavior).

Response is `Content-Type: text/event-stream`, streamed in order:

1. `event: local` — `data: { files: SharedFileDto[], total: number }`, written
   immediately after the local DB query resolves.
2. `event: network` — `data: NetworkResult[]`, one per batch as
   `initiateNetworkSearch`'s new `onBatch` callback fires. Zero or more of these.
3. `event: done` — `data: {}`, written once `initiateNetworkSearch`'s returned
   Promise resolves (settle timeout, result cap, or full timeout — unchanged
   trigger conditions). The stream closes immediately after.

If there are no connected accepted peers, `done` is written immediately after
`local` (skip calling `initiateNetworkSearch`, matching its own existing
`if (peers.length === 0) return []` short-circuit).

## Server changes

- **`server/search-protocol.ts`**: `initiateNetworkSearch` gains one new optional
  trailing parameter, `onBatch?: (batch: NetworkResult[]) => void`. Called from
  `handleSearchResult`, at the point where `added > 0` (right where
  `pending.resultsPerSender.set(...)` already runs), with just the newly-added
  items. Purely additive — existing callers/tests that omit it are unaffected, and
  the Promise still resolves with the full accumulated array for anyone still using
  it that way.
- **`server/management.ts`**: new `/api/search/stream` handler:
  - Validates query params (reuse `SearchQuerySchema`, dropping `network` — always
    on — and `limit`/`offset`, not used by network search today).
  - Builds a `ReadableStream` that: runs `searchFiles()`, enqueues the `local`
    event; if no connected accepted peers, enqueues `done` and closes; otherwise
    calls `initiateNetworkSearch(identity, peers, { query, fileType }, ..., onBatch)`
    where `onBatch` enqueues a `network` event per batch, then enqueues `done` and
    closes once the returned Promise resolves.
  - Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
    `Connection: keep-alive`.
  - `/api/search` (existing endpoint) drops its `network` branch and the `network`
    query param — becomes local-search-only, still useful for scripting/curl against
    just this node's index without pulling in SSE.

## Frontend changes

- **`app/lib/api.ts`**: new `streamSearch(params: { q: string; type: FileType },
handlers: { onLocal, onNetworkBatch, onDone, onError })` wrapping `EventSource`,
  built on the existing `apiUrl()` host-resolution helper (same pattern used by every
  other API call in this file). Returns the `EventSource` instance so the caller can
  `.close()` it for cleanup.
- **`app/(shell)/search/SearchView.tsx`**: mount effect replaces the current
  `searchFiles(...).then(...)` call with `streamSearch(...)`:
  - `onLocal(files)` → `setLocalFiles(files)`, recompute `hits` via existing
    `mergeResults`.
  - `onNetworkBatch(batch)` → append to an accumulated `networkResults` array,
    recompute `hits` via `mergeResults` again (cheap — capped at 200 total network
    results, this is a Map rebuild over at most a couple hundred items per batch).
  - `onDone()` → clear the "searching" indicator, `setLoading(false)`, same end
    state as today.
  - `onError()` (before `done`) → existing `styles.error` "Search failed. Is the
    server running?" message, but keep whatever partial `hits` already rendered
    rather than clearing them.
  - Effect cleanup calls `.close()` on the `EventSource`, replacing today's
    `AbortController.abort()` in the same role (unmount / param change via the
    existing remount-on-navigation pattern).
- New inline "Searching network…" indicator (small spinner) shown near
  `resultsHeader` while streaming is active; replaced by the existing final result
  count once `onDone` fires. The Search button's existing "Searching…" disabled
  state is unchanged — still spans the whole operation.

## Error handling

- SSE connection error before `done`: show the existing search-failure message,
  keep partial results, re-enable the Search button (same as today's catch branch).
- Malformed/unparseable SSE payload: treated as a stream error, same handling as
  above — this shouldn't happen since both ends are this same codebase, so no need
  for granular per-field validation on the client.
- All existing protections (TTL, cycle prevention, `MAX_NETWORK_RESULTS`,
  `MAX_RESULTS_PER_SENDER`, route expiry) are unchanged — this is purely a delivery
  mechanism change on top of already-collected, already-capped data.

## Code impact

- `server/search-protocol.ts`: add `onBatch` param to `initiateNetworkSearch`.
- `server/management.ts`: add `/api/search/stream` handler; remove the `network`
  branch from `/api/search`.
- `server/schemas.ts`: `SearchQuerySchema` — drop `network` field (no longer read by
  any handler).
- `app/lib/api.ts`: add `streamSearch()`; remove `network` from `SearchParams` and
  the `SearchResponse.network` field usage tied to the old flow (keep `NetworkFile`
  type — still used by `streamSearch`'s batch payloads).
- `app/(shell)/search/SearchView.tsx`: swap `searchFiles()` call for `streamSearch()`;
  add searching-indicator state and markup.
- `app/(shell)/search/search.module.css`: new class for the inline searching
  indicator (spinner + text), styled consistent with existing `resultsHeader`.

## Testing

- Backend (Jest):
  - `search-protocol.test.ts`: `onBatch` fires once per batch with just the newly
    added items, is not called when a `handleSearchResult` call adds nothing
    (all-duplicate batch), and the Promise still resolves with the full aggregate
    when `onBatch` is provided.
  - `management.test.ts`: new test(s) for `/api/search/stream` reading the
    `Response`'s body stream and asserting `local` → `network`(×N) → `done` event
    ordering and JSON payloads; the zero-connected-peers case (skips straight from
    `local` to `done`); `/api/search` still works local-only with `network` param
    removed/ignored.
- Frontend (Playwright): update existing search spec(s) to mock
  `/api/search/stream` via `page.route()`, fulfilling a `text/event-stream` body
  with SSE frames (`event: local\ndata: {...}\n\n`, etc.). Assert local results
  render before a network batch is "delivered" in the mocked body, the searching
  indicator is visible during the stream and gone after `done`, and the error path
  (route aborts mid-stream) shows the failure message while preserving partial
  results already rendered.

## Workflow

- Built on `feature/streaming-search-results`, per project convention (feature
  branch → PR → Copilot review → merge).
- Update `CHANGELOG.md`'s `[Unreleased]` section.
- Update `TODO.md` to check off the "Stream" in search results item.
