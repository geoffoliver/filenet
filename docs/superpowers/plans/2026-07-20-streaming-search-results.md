# Streaming Search Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make network search results appear incrementally in the Search UI as peers respond, instead of the client blocking on the full ~5s round trip, with a visible "still searching" indicator.

**Architecture:** New `GET /api/search/stream` SSE endpoint in `server/management.ts` emits a `local` event immediately (synchronous local DB query), one `network` event per result batch as `initiateNetworkSearch` collects them (a new `onBatch` callback added to that function), then a `done` event. `GET /api/search` loses its network branch and becomes local-only. The frontend replaces its single blocking `searchFiles()` call with an `EventSource`-based `streamSearch()` helper that merges results into the table as each event arrives.

**Tech Stack:** Bun (server, `ReadableStream`-based `Response`), Next.js/React (`EventSource` in the browser), Zod (query validation), `bun test` (backend/lib unit tests), Playwright (e2e).

## Global Constraints

- SSE event order is always `local` → zero-or-more `network` → `done`, in that exact sequence, per the design spec.
- No changes to the P2P wire protocol (`search-request`/`search-result` messages between nodes) — this is a local UI/server-only change.
- No new dependencies — `ReadableStream`/`Response` (server) and `EventSource` (browser) are both already available without a package install.
- `MAX_NETWORK_RESULTS`, `MAX_RESULTS_PER_SENDER`, TTL, dedup, and route-expiry behavior in `server/search-protocol.ts` are unchanged — only how already-collected results are surfaced changes.
- Built on branch `feature/streaming-search-results`.
- Update `CHANGELOG.md`'s `[Unreleased]` section and check off the "Stream" in search results item in `TODO.md` as part of the final task.

---

### Task 1: `onBatch` callback on `initiateNetworkSearch`

**Files:**

- Modify: `server/search-protocol.ts`
- Test: `server/__tests__/search-protocol.test.ts`

**Interfaces:**

- Produces: `initiateNetworkSearch(identity, peers, params, timeoutMs?, sendFn?, settleTimeoutMs?, onBatch?: (batch: NetworkResult[]) => void): Promise<NetworkResult[]>` — the new 7th parameter is additive; all existing call sites that omit it are unaffected. `onBatch` is invoked once per `handleSearchResult` call that adds at least one new result, with only the newly-added `NetworkResult[]` items (not the full accumulated list).

- [ ] **Step 1: Write the failing tests**

Add to the `describe('initiateNetworkSearch', ...)` block in `server/__tests__/search-protocol.test.ts` (after the existing `'deduplicates results with the same sha256 from the same node'` test, before `'caps collected results at MAX_NETWORK_RESULTS'`):

```typescript
it('invokes onBatch with newly added results as they arrive', async () => {
  const peer = makePeer('batch-peer');
  const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
  const batches: NetworkResult[][] = [];
  const networkResultsPromise = initiateNetworkSearch(
    identity,
    [peer],
    { query: 'batch-test', fileType: 'all' },
    5_000,
    captureAll(sent),
    50,
    (batch) => batches.push(batch),
  );
  await Bun.sleep(10);
  const reqMsg = sent[0].msg as SearchRequestMessage;
  handleSearchResult({
    type: 'search-result',
    searchId: reqMsg.searchId,
    fromNodeId: 'batch-peer',
    results: [
      {
        filename: 'a.mp3',
        size: '100',
        sha256: 'a'.repeat(64),
        mimeType: 'audio/mpeg',
        metadata: null,
      },
    ],
  });
  const results = await networkResultsPromise;
  expect(results).toHaveLength(1);
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(1);
  expect(batches[0][0].sha256).toBe('a'.repeat(64));
  expect(batches[0][0].nodeId).toBe('batch-peer');
});

it('does not invoke onBatch when a result batch adds no new results', async () => {
  const peer = makePeer('dup-batch-peer');
  const sent: { peer: ConnectedPeer; msg: InnerMessage }[] = [];
  const batches: NetworkResult[][] = [];
  const networkResultsPromise = initiateNetworkSearch(
    identity,
    [peer],
    { query: 'dup-batch-test', fileType: 'all' },
    5_000,
    captureAll(sent),
    50,
    (batch) => batches.push(batch),
  );
  await Bun.sleep(10);
  const reqMsg = sent[0].msg as SearchRequestMessage;
  const resultMsg: SearchResultMessage = {
    type: 'search-result',
    searchId: reqMsg.searchId,
    fromNodeId: 'dup-batch-peer',
    results: [
      {
        filename: 'a.mp3',
        size: '100',
        sha256: 'a'.repeat(64),
        mimeType: 'audio/mpeg',
        metadata: null,
      },
    ],
  };
  handleSearchResult(resultMsg);
  handleSearchResult(resultMsg); // duplicate — adds nothing
  const results = await networkResultsPromise;
  expect(results).toHaveLength(1);
  expect(batches).toHaveLength(1); // only the first call added anything
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/search-protocol.test.ts -t "onBatch"`
Expected: FAIL — `initiateNetworkSearch` doesn't accept a 7th argument yet, so `batches` stays empty and both `expect(batches).toHaveLength(1)` assertions fail.

- [ ] **Step 3: Implement `onBatch`**

In `server/search-protocol.ts`, add `onBatch` to the `PendingSearch` type (after `resolve`):

```typescript
type PendingSearch = {
  results: NetworkResult[];
  seenKeys: Set<string>;
  resultsPerSender: Map<string, number>; // authenticated sender → result count
  timer: ReturnType<typeof setTimeout>;
  settleTimer: ReturnType<typeof setTimeout> | null;
  settleTimeoutMs: number;
  resolve: (results: NetworkResult[]) => void;
  onBatch?: (batch: NetworkResult[]) => void;
};
```

In `handleSearchResult`, replace the result-collection loop (the block starting `const sender = msg.viaNodeId ?? msg.fromNodeId;` through the `if (added > 0) {` body) with:

```typescript
const sender = msg.viaNodeId ?? msg.fromNodeId;
const senderCount = pending.resultsPerSender.get(sender) ?? 0;
const newItems: NetworkResult[] = [];
let added = 0;
for (const item of msg.results) {
  if (pending.results.length >= MAX_NETWORK_RESULTS) break;
  if (senderCount + added >= MAX_RESULTS_PER_SENDER) break;
  // JSON.stringify avoids key collisions when fromNodeId contains the separator character
  const key = JSON.stringify([msg.fromNodeId, item.sha256]);
  if (!pending.seenKeys.has(key)) {
    pending.seenKeys.add(key);
    const result: NetworkResult = { ...item, nodeId: msg.fromNodeId, viaNodeId: msg.viaNodeId };
    pending.results.push(result);
    newItems.push(result);
    added++;
  }
}
if (added > 0) {
  pending.resultsPerSender.set(sender, senderCount + added);
  pending.onBatch?.(newItems);
  // Reset the settle timer — resolve early if no new results arrive within the window.
  if (pending.settleTimer) clearTimeout(pending.settleTimer);
  pending.settleTimer = setTimeout(() => {
    clearTimeout(pending.timer);
    pendingSearches.delete(msg.searchId);
    searchRoutes.delete(msg.searchId);
    pending.resolve(pending.results);
  }, pending.settleTimeoutMs);
}
```

Update `initiateNetworkSearch`'s signature and the `pending` object literal:

```typescript
export async function initiateNetworkSearch(
  identity: Identity,
  peers: ConnectedPeer[],
  params: { query: string; fileType: string },
  timeoutMs = SEARCH_TIMEOUT_MS,
  sendFn: (peer: ConnectedPeer, msg: InnerMessage) => void = sendToPeer,
  settleTimeoutMs = SETTLE_TIMEOUT_MS,
  onBatch?: (batch: NetworkResult[]) => void,
): Promise<NetworkResult[]> {
```

```typescript
const pending: PendingSearch = {
  results: [],
  seenKeys: new Set(),
  resultsPerSender: new Map(),
  timer: setTimeout(() => {
    if (pending.settleTimer) clearTimeout(pending.settleTimer);
    pendingSearches.delete(searchId);
    searchRoutes.delete(searchId);
    resolve(pending.results);
  }, timeoutMs),
  settleTimer: null,
  settleTimeoutMs,
  resolve,
  onBatch,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/search-protocol.test.ts`
Expected: PASS — all tests in the file, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add server/search-protocol.ts server/__tests__/search-protocol.test.ts
git commit -m "feat: add onBatch callback to initiateNetworkSearch"
```

---

### Task 2: `SearchStreamQuerySchema`

**Files:**

- Modify: `server/schemas.ts`

**Interfaces:**

- Produces: `SearchStreamQuerySchema` (Zod) — validates `{ q?, type? }` with the same rules `SearchQuerySchema` already applies to those two fields.

- [ ] **Step 1: Add the schema**

In `server/schemas.ts`, immediately after the closing `});` of `SearchQuerySchema` (the one that currently ends with the `network` field), add:

```typescript
export const SearchStreamQuerySchema = SearchQuerySchema.pick({ q: true, type: true });
```

- [ ] **Step 2: Typecheck**

Run: `bun run build`
Expected: build succeeds (this is a pure additive export; nothing consumes it yet, so there's no runtime behavior to test in isolation — it's exercised end-to-end by Task 3's tests).

- [ ] **Step 3: Commit**

```bash
git add server/schemas.ts
git commit -m "feat: add SearchStreamQuerySchema"
```

---

### Task 3: `GET /api/search/stream` SSE endpoint

**Files:**

- Modify: `server/management.ts`
- Test: `server/__tests__/management.test.ts`

**Interfaces:**

- Consumes: `initiateNetworkSearch(..., onBatch?)` from Task 1; `SearchStreamQuerySchema` from Task 2; existing `searchFiles`, `toSharedFileDto`, `getAcceptedConnectedPeers`, `sendToPeer`.
- Produces: `GET /api/search/stream?q=&type=` — SSE response, `Content-Type: text/event-stream`, emitting `event: local` (`{ files: SharedFileDto[], total: number }`), zero-or-more `event: network` (`NetworkResult[]`), then `event: done` (`{}`), then closes.

- [ ] **Step 1: Write the failing tests**

Add near the top of `server/__tests__/management.test.ts`, alongside the other test helpers (after the `jsonReq` function):

```typescript
function parseSseEvents(text: string): { event: string; data: unknown }[] {
  return text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const eventLine = frame.split('\n').find((l) => l.startsWith('event: '))!;
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      };
    });
}
```

Add a new `describe` block in `server/__tests__/management.test.ts`, placed right after the existing `describe('GET /api/search', ...)` block closes (after its final `});` — currently the block containing the `'network=true includes results from connected peers...'` test):

```typescript
describe('GET /api/search/stream', () => {
  beforeEach(async () => {
    db.insert(sharedFiles)
      .values(
        [
          {
            path: '/music/song.mp3',
            filename: 'song.mp3',
            size: 1000n,
            sha256: 'a'.repeat(64),
            mimeType: 'audio/mpeg',
            metadata: null,
          },
        ].map((d) => ({
          id: randomUUID(),
          lastSeenAt: new Date(),
          indexedAt: new Date(),
          updatedAt: new Date(),
          ...d,
        })),
      )
      .run();
  });

  it('sends local results immediately, then done, when there are no connected peers', async () => {
    const res = await makeHandler()(req('/api/search/stream?q=song'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const events = parseSseEvents(await res.text());
    expect(events.map((e) => e.event)).toEqual(['local', 'done']);
    const localData = events[0].data as { files: { filename: string }[]; total: number };
    expect(localData.files).toHaveLength(1);
    expect(localData.files[0].filename).toBe('song.mp3');
  });

  it('streams a network batch between local and done when a peer is connected', async () => {
    const nodeId = 'alice-node';
    db.insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Alice',
        address: '10.0.0.99',
        port: 7734,
        nodeId,
        status: 'ACCEPTED',
      })
      .run();
    registerPeer(
      { send: () => {}, close: () => {} },
      Buffer.alloc(32),
      nodeId,
      Buffer.alloc(32),
      '10.0.0.99',
      7734,
    );
    try {
      const fakeNetworkResult = {
        filename: 'remote.mp3',
        size: '9999',
        sha256: 'b'.repeat(64),
        mimeType: 'audio/mpeg',
        metadata: null,
        nodeId,
      };
      const handler = createManagementFetch({
        identity,
        db,
        connectPeer: neverConnect,
        updater: makeFakeUpdater(),
        networkSearch: async (_id, _peers, _params, _t, _s, _st, onBatch) => {
          onBatch?.([fakeNetworkResult]);
          return [fakeNetworkResult];
        },
      });

      const res = await handler(req('/api/search/stream?q=song'));
      const events = parseSseEvents(await res.text());
      expect(events.map((e) => e.event)).toEqual(['local', 'network', 'done']);
      expect((events[1].data as unknown[])[0]).toMatchObject({ filename: 'remote.mp3' });
    } finally {
      unregisterPeer(nodeId);
    }
  });

  it('returns 400 for invalid type', async () => {
    const res = await makeHandler()(req('/api/search/stream?type=unknown'));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/management.test.ts -t "api/search/stream"`
Expected: FAIL — `/api/search/stream` doesn't exist yet, so requests hit the `404 Not Found` fallback and `res.status` is `404`, not `200`/`400`.

- [ ] **Step 3: Implement the endpoint**

In `server/management.ts`, update the schema import to include `SearchStreamQuerySchema`:

```typescript
import {
  AddFriendBodySchema,
  AddScriptBodySchema,
  FriendActionBodySchema,
  PatchSettingsBodySchema,
  ReorderScriptBodySchema,
  SearchQuerySchema,
  SearchStreamQuerySchema,
} from './schemas';
```

Update the `search-protocol` import to also bring in the two timing constants:

```typescript
import { SEARCH_TIMEOUT_MS, SETTLE_TIMEOUT_MS, initiateNetworkSearch } from './search-protocol';
```

Add the new route immediately after the existing `/api/search` block's closing `}` (i.e. right before the `if (url.pathname === '/api/stats' && req.method === 'GET') {` line):

```typescript
if (url.pathname === '/api/search/stream' && req.method === 'GET') {
  const result = SearchStreamQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!result.success) {
    return new Response(result.error.issues[0].message, { status: 400 });
  }
  const { q, type } = result.data;
  const encoder = new TextEncoder();
  const sseEvent = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const localResult = await searchFiles(db, { query: q, type, limit: 50, offset: 0 });
        controller.enqueue(
          sseEvent('local', {
            files: localResult.files.map(toSharedFileDto),
            total: localResult.total,
          }),
        );

        const peers = await getAcceptedConnectedPeers(db);
        if (peers.length === 0) {
          controller.enqueue(sseEvent('done', {}));
          controller.close();
          return;
        }

        await networkSearch(
          identity,
          peers,
          { query: q, fileType: type },
          SEARCH_TIMEOUT_MS,
          sendToPeer,
          SETTLE_TIMEOUT_MS,
          (batch) => controller.enqueue(sseEvent('network', batch)),
        );
        controller.enqueue(sseEvent('done', {}));
        controller.close();
      } catch (err) {
        console.error('Search stream error:', err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/management.test.ts`
Expected: PASS — full file, including the three new tests and all pre-existing ones (the old `/api/search` tests are untouched by this task).

- [ ] **Step 5: Commit**

```bash
git add server/management.ts server/__tests__/management.test.ts
git commit -m "feat: add GET /api/search/stream SSE endpoint"
```

---

### Task 4: Make `GET /api/search` local-only

**Files:**

- Modify: `server/management.ts`
- Modify: `server/schemas.ts`
- Modify: `server/__tests__/management.test.ts`

**Interfaces:**

- Produces: `GET /api/search?q=&type=&limit=&offset=` — unchanged local-search behavior, `{ files, total }`, no `network` field ever (query param removed, no longer parsed).

- [ ] **Step 1: Remove `network` from `SearchQuerySchema`**

In `server/schemas.ts`, remove the `network` line from `SearchQuerySchema`:

```typescript
export const SearchQuerySchema = z.object({
  q: z.string().max(500).optional().default(''),
  type: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['all', 'audio', 'video', 'image', 'document', 'ebook']).optional().default('all'),
  ),
  limit: z.preprocess(coerceInt, z.int().min(1).max(200).optional().default(50)),
  offset: z.preprocess(coerceInt, z.int().min(0).optional().default(0)),
});
```

- [ ] **Step 2: Simplify the `/api/search` handler**

In `server/management.ts`, replace the existing `/api/search` block with:

```typescript
if (url.pathname === '/api/search' && req.method === 'GET') {
  const result = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!result.success) {
    return new Response(result.error.issues[0].message, { status: 400 });
  }
  const { q, type, limit, offset } = result.data;
  const localResult = await searchFiles(db, { query: q, type, limit, offset });
  return Response.json({
    files: localResult.files.map(toSharedFileDto),
    total: localResult.total,
  });
}
```

- [ ] **Step 3: Remove the now-obsolete network tests**

In `server/__tests__/management.test.ts`, in the `describe('GET /api/search', ...)` block, delete these four tests (they exercised the `network=true` branch that no longer exists):

- `'omits network field when network param is not set'`
- `'network=true returns empty network array when accepted friends are not connected'`
- `'network=true does not fan out to pending friends'`
- `'network=true includes results from connected peers alongside local results'`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/management.test.ts`
Expected: PASS — the remaining `/api/search` tests (empty query, filters, limit/offset, 400s) all still pass; the removed tests are gone; the `/api/search/stream` tests from Task 3 are unaffected and still pass.

- [ ] **Step 5: Commit**

```bash
git add server/management.ts server/schemas.ts server/__tests__/management.test.ts
git commit -m "refactor: make GET /api/search local-only"
```

---

### Task 5: `streamSearch()` client helper

**Files:**

- Modify: `app/lib/api.ts`

**Interfaces:**

- Consumes: `LocalFile`, `NetworkFile`, `FileType`, `apiUrl` (all already defined in this file).
- Produces: `streamSearch(params: SearchStreamParams, handlers: SearchStreamHandlers): EventSource`, where:

  ```typescript
  type SearchStreamParams = { q: string; type?: FileType };
  type SearchStreamHandlers = {
    onLocal: (data: { files: LocalFile[]; total: number }) => void;
    onNetworkBatch: (batch: NetworkFile[]) => void;
    onDone: () => void;
    onError: () => void;
  };
  ```

  `onDone` fires exactly once, after which the returned `EventSource` is already closed. `onError` fires at most once and only if the stream fails before `onDone`; the `EventSource` is closed in that case too. The caller may also call `.close()` on the returned instance directly (e.g. on unmount) — closing an already-closed `EventSource` is a no-op per the spec.

- [ ] **Step 1: Replace the `SearchResponse`/`SearchParams` types**

In `app/lib/api.ts`, replace:

```typescript
export type SearchResponse = {
  files: LocalFile[];
  total: number;
  network?: NetworkFile[];
};

export type SearchParams = {
  q: string;
  type?: FileType;
  limit?: number;
  offset?: number;
  network?: boolean;
};
```

with:

```typescript
export type SearchStreamParams = {
  q: string;
  type?: FileType;
};

export type SearchStreamHandlers = {
  onLocal: (data: { files: LocalFile[]; total: number }) => void;
  onNetworkBatch: (batch: NetworkFile[]) => void;
  onDone: () => void;
  onError: () => void;
};
```

- [ ] **Step 2: Replace `searchFiles()` with `streamSearch()`**

Replace:

```typescript
export async function searchFiles(
  params: SearchParams,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  if (params.network) qs.set('network', 'true');
  const res = await fetch(apiUrl(`/api/search?${qs}`), { signal });
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}
```

with:

```typescript
export function streamSearch(
  params: SearchStreamParams,
  handlers: SearchStreamHandlers,
): EventSource {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  const es = new EventSource(apiUrl(`/api/search/stream?${qs}`));
  let finished = false;
  es.addEventListener('local', (e) => {
    handlers.onLocal(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener('network', (e) => {
    handlers.onNetworkBatch(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener('done', () => {
    finished = true;
    handlers.onDone();
    es.close();
  });
  es.onerror = () => {
    if (finished) return;
    handlers.onError();
    es.close();
  };
  return es;
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run build`
Expected: build fails at this step — `app/(shell)/search/SearchView.tsx` still imports and calls the now-removed `searchFiles`. This is expected; Task 6 fixes it. (If you're executing tasks out of order for any reason, don't stop here — proceed straight to Task 6, then re-run the build.)

- [ ] **Step 4: Commit**

```bash
git add app/lib/api.ts
git commit -m "feat: add streamSearch() client helper, remove searchFiles()"
```

---

### Task 6: Wire `SearchView` to the stream, add the searching indicator

**Files:**

- Modify: `app/(shell)/search/SearchView.tsx`
- Modify: `app/(shell)/search/search.module.css`

**Interfaces:**

- Consumes: `streamSearch`, `SearchStreamParams`, `SearchStreamHandlers` from Task 5; `LocalFile`, `NetworkFile` types from `app/lib/api.ts`; existing `mergeResults` from `app/lib/searchResults.ts`.

- [ ] **Step 1: Update imports**

In `app/(shell)/search/SearchView.tsx`, replace:

```typescript
import type { FileType } from '../../lib/api';
import { searchFiles } from '../../lib/api';
```

with:

```typescript
import type { FileType, LocalFile, NetworkFile } from '../../lib/api';
import { streamSearch } from '../../lib/api';
```

- [ ] **Step 2: Replace the mount effect**

Replace the existing mount effect:

```typescript
useEffect(() => {
  if (!initialQ.trim()) return;
  const controller = new AbortController();
  searchFiles({ q: initialQ, type: initialType, network: true }, controller.signal)
    .then((res) => {
      setHits(mergeResults(res.files, res.network ?? []));
      setSelected(new Set());
      setHasSearched(true);
      setLoading(false);
    })
    .catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError('Search failed. Is the server running?');
      setHasSearched(true);
      setLoading(false);
    });
  return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // intentionally empty — component remounts when params change
```

with:

```typescript
useEffect(() => {
  if (!initialQ.trim()) return;
  let localFiles: LocalFile[] = [];
  let networkResults: NetworkFile[] = [];
  const es = streamSearch(
    { q: initialQ, type: initialType },
    {
      onLocal: (data) => {
        localFiles = data.files;
        setHits(mergeResults(localFiles, networkResults));
        setSelected(new Set());
      },
      onNetworkBatch: (batch) => {
        networkResults = [...networkResults, ...batch];
        setHits(mergeResults(localFiles, networkResults));
      },
      onDone: () => {
        setHasSearched(true);
        setLoading(false);
      },
      onError: () => {
        setError('Search failed. Is the server running?');
        setHasSearched(true);
        setLoading(false);
      },
    },
  );
  return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []); // intentionally empty — component remounts when params change
```

- [ ] **Step 3: Add the searching indicator**

In the JSX, immediately before the `{hasSearched && !loading && !error && (` results-header block, add:

```tsx
{
  loading && !error && (
    <div className={styles.searching} role="status">
      <span className={styles.searchingSpinner} aria-hidden="true" />
      Searching network…
    </div>
  );
}
```

- [ ] **Step 4: Add the indicator styles**

In `app/(shell)/search/search.module.css`, immediately after the `.error` block, add:

```css
.searching {
  @apply flex
    items-center
    gap-2
    text-sm
    text-[var(--text-muted)]
    mb-4;
}

.searchingSpinner {
  @apply w-3
    h-3
    rounded-full
    border-2
    border-[var(--border)]
    border-t-[var(--color-primary)]
    animate-spin
    flex-shrink-0;
}
```

- [ ] **Step 5: Typecheck and build**

Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add "app/(shell)/search/SearchView.tsx" "app/(shell)/search/search.module.css"
git commit -m "feat: stream search results into SearchView with a searching indicator"
```

---

### Task 7: Update Playwright coverage

**Files:**

- Modify: `e2e/helpers.ts`
- Modify: `e2e/search.spec.ts`

**Interfaces:**

- Consumes: nothing new — `mockSearch(page, results)` keeps its existing call signature, so no call site in `search.spec.ts` (other than the new test) needs to change.

- [ ] **Step 1: Update `mockSearch` to fulfill an SSE body**

In `e2e/helpers.ts`, replace:

```typescript
export async function mockSearch(
  page: Page,
  results: { files: object[]; total: number; network?: object[] } = {
    files: [],
    total: 0,
    network: [],
  },
) {
  await page.route('/api/search**', (route) => route.fulfill({ json: results }));
}
```

with:

```typescript
export async function mockSearch(
  page: Page,
  results: { files: object[]; total: number; network?: object[] } = {
    files: [],
    total: 0,
    network: [],
  },
) {
  const frames = [
    `event: local\ndata: ${JSON.stringify({ files: results.files, total: results.total })}\n\n`,
  ];
  if (results.network && results.network.length > 0) {
    frames.push(`event: network\ndata: ${JSON.stringify(results.network)}\n\n`);
  }
  frames.push(`event: done\ndata: {}\n\n`);
  await page.route('/api/search**', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: frames.join('') }),
  );
}
```

- [ ] **Step 2: Run the existing search spec to confirm nothing broke**

Run: `bunx playwright test e2e/search.spec.ts`
Expected: PASS — all pre-existing tests in the file pass unchanged, since `mockSearch`'s call signature didn't change, only its internal response format.

- [ ] **Step 3: Add a test for the searching indicator**

Add to `e2e/search.spec.ts` (anywhere after the `NETWORK_FILE` constant is defined, e.g. right after the `'shows results from the network'` test):

```typescript
test('shows a searching indicator while the stream is in flight, hidden once done', async ({
  page,
}) => {
  let resolveFulfill: () => void;
  const gate = new Promise<void>((r) => (resolveFulfill = r));
  await page.route('/api/search**', async (route) => {
    await gate;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `event: local\ndata: ${JSON.stringify({ files: [], total: 0 })}\n\nevent: done\ndata: {}\n\n`,
    });
  });
  await page.goto('/search?q=song&type=all');
  await expect(page.getByRole('status', { name: /searching network/i })).toBeVisible();
  resolveFulfill!();
  await expect(page.getByRole('status', { name: /searching network/i })).not.toBeVisible();
});
```

- [ ] **Step 4: Run the full search spec again**

Run: `bunx playwright test e2e/search.spec.ts`
Expected: PASS — including the new test.

- [ ] **Step 5: Run the full Playwright suite**

Run: `bunx playwright test`
Expected: PASS — confirms nothing outside `search.spec.ts` depended on the old `/api/search` network behavior.

- [ ] **Step 6: Commit**

```bash
git add e2e/helpers.ts e2e/search.spec.ts
git commit -m "test: cover streaming search results and the searching indicator"
```

---

### Task 8: Docs and changelog

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `TODO.md`

- [ ] **Step 1: Update the changelog**

In `CHANGELOG.md`, under the `## [Unreleased]` heading (create an `### Changed` subsection if one doesn't already exist there), add:

```markdown
- Network search results now stream in as peers respond instead of waiting for the full round trip, with a "Searching network…" indicator while in progress.
```

- [ ] **Step 2: Check off the TODO item**

In `TODO.md`, under `## Infrastructure`, change:

```markdown
- [ ] "Stream" in search results - Rather than waiting for all the results to be delivered back to a client (which could take a while on a large network) before displaying the results, display results as soon as they are available and update the list as new results come in. It would be nice if there was an indicator to the user that the search was still running so users don't get confused.
```

to:

```markdown
- [x] "Stream" in search results — `GET /api/search/stream` (SSE) emits local results immediately, then network results batch-by-batch as peers respond, then `done`; `SearchView` renders each as it arrives and shows a "Searching network…" indicator while the stream is open.
```

- [ ] **Step 3: Run the full test suite one more time**

Run: `bun test server/__tests__ scripts/__tests__ app/lib/__tests__ app/hooks/__tests__ && bunx playwright test`
Expected: PASS — everything green before opening the PR.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md TODO.md
git commit -m "docs: update changelog and TODO for streaming search results"
```

---

## Final Step: Open the PR

After all tasks are committed on `feature/streaming-search-results`, push the branch and open a PR against `master` per this project's standard workflow (feature branch → PR → Copilot review → merge).
