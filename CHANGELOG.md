# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-07-18

### Fixed

- **Setup wizard and "Rescan now" hung indefinitely on large libraries** — `PATCH /api/settings` (when `sharedFolders` changes) and `POST /api/rescan` used to `await` the full folder scan before responding, so the request stayed open for as long as the scan took. For a library of hundreds of thousands of files, hashing every byte of every file sequentially can take far longer than any HTTP request should stay open for, leaving the setup wizard stuck on "Saving…" with no feedback. Both endpoints now kick off the scan in the background and respond immediately; indexed files show up in Search/Home as the scan makes progress. `POST /api/rescan` returns `202 Accepted` (previously `200` with `{ indexed, removed }` counts) and still returns `409` if a scan is already running.
- **File watcher never reactively cleaned up a file replaced by a symlink, on Linux** — when a shared file was deleted and immediately replaced by a symlink at the same path, chokidar emits a `change` event for it on macOS (which the watcher already handled), but on Linux (inotify) it emits nothing further at all — only the original `unlink`. The stale index row was then never cleaned up reactively, and `confirmAndRemove`'s own grace-period fallback also missed it (an `lstat` on a symlink succeeds, so it was mistaken for "the file came back"). Found via a native-Linux repro while investigating a newly-flaky test, not previously known. Fixed on both platforms: `confirmAndRemove` now treats a symlink the same as a deleted file, and a new short settle-check on every `unlink` event catches the common case well before the (default 30s) grace period would.

## [0.2.0] - 2026-07-18

### Added

- **Auto-update mechanism** — the standalone binary checks GitHub for new releases (configurable repo, default `geoffoliver/filenet`), downloads and SHA-256-verifies them in the background, and self-relaunches onto the new version from a "Restart to update" button in Settings. Desktop notification (with toast fallback) fires once a new version is ready to install.
- **Reactive filesystem watcher** — shared folders are now watched (chokidar-based) for changes, indexing new/modified/deleted files within seconds instead of waiting for the periodic rescan. Periodic/manual rescanning is unchanged and still runs as a fallback safety net.
- **Auto-open browser** — the server now opens the UI in your default browser on start (configurable in Settings, default on); safely no-ops with a logged warning if no browser is available (e.g. a headless server).
- **App icon and web manifest** — favicon is now a 📁 emoji rendered as SVG (`app/icon.svg`); a generated web manifest (`app/manifest.ts`) lets the app be installed to a desktop/dock/home screen from supporting browsers.
- **GitHub Pages site** — a static landing page and docs site under `site/` (no build step, auto light/dark via `prefers-color-scheme`), with real app screenshots and an installation/configuration/scripting reference, deployed automatically via `.github/workflows/pages.yml` on push to master. Live at `https://geoffoliver.github.io/filenet/`.

### Removed

- **Unauthenticated `GET /pubkey` and `GET /health` endpoints** — both lived on the P2P port with no in-app consumers; the WebSocket `hello`/`hello-ack` handshake already delivers and cryptographically proves each peer's public key, so `/pubkey` was never load-bearing. Removing them means a bare `curl` can no longer fingerprint a node's `nodeId` without implementing the WS handshake protocol.
- **Docker support** — removed `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, and `docker-compose.yml`. Single-binary distribution (`bun run build:binaries`) is now the only supported self-hosting path. Also removed the `SHARED_FOLDERS`/`DOWNLOAD_FOLDER` environment-variable override system (server config, `/api/settings/env`, the setup wizard's step-skipping, and the locked-field UI in Settings), which existed solely to support Docker's volume-mount deployment model.

## [0.1.1] - 2026-07-07

### Added

- **Single-binary distribution** — the app now builds and runs as a standalone executable via `bun build --compile`, with no external Node/Bun/npm dependency required at runtime
  - Next.js switched to `output: 'export'`; the UI is now static files served directly by the Bun server
  - The management API (`/api/*`) is now handled in-process by the same server that serves the UI, instead of a separate `127.0.0.1:7735` process — removes the `MGMT_PORT` env var entirely
  - `bun run build:binaries` compiles and packages all five targets (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`) as `dist/filenet-<target>.tar.gz`/`.zip`, each containing the executable alongside its `out/` and `drizzle/migrations/` folders
  - Docker continues to run from source, now serving the static export instead of a Next.js server; `docker-entrypoint.sh` simplified to a single process

### Fixed

- **Standalone binary failed to start on first run** — `new Database(path, { create: true })` only creates the database file, not missing parent directories; the default `./data/filenet.db` path worked in every previously-tested deployment (a tracked `data/.gitkeep` in git checkouts, an explicit `mkdir -p /app/data` in Docker) but a freshly extracted binary archive has no `data/` folder, so first launch crashed with `SQLITE_CANTOPEN`. `createDb()` now creates the parent directory itself
- **Shared folders weren't scanned until manually triggered** — finishing the setup wizard or saving shared folders in Settings only saved the setting; nothing scanned the newly configured folders until the user found the "Force rescan" button. `PATCH /api/settings` now scans immediately when `sharedFolders` is included in the patch, matching the existing blocking/spinner UX of the manual rescan button

- **Transfers view overhaul** — Napster-style split pane with resizable drag handle; downloads pane (top) and uploads pane (bottom); dense table-style rows showing inline progress bar, bytes received/total, speed, ETA, and source count; status bar at bottom showing concurrent download/upload counts; "Clear Finished" button; live upload session tracking (in-memory, per peer/file, 30 s idle expiry) exposed via new `GET /api/uploads` endpoint

- **Search download feedback** — after clicking Download in search results, the button polls `/api/transfers` every 2 s and reflects live state: Starting… → Queued → 42% → Done ✓; re-enables on failure or cancellation so the user can retry

- **Peer reconnect loop** — the server now automatically re-dials `ACCEPTED` and `OUTGOING_PENDING` friends every 30 seconds so dropped connections re-establish and offline peers are retried without user action
  - Duplicate in-flight dials are suppressed; first dial failure per address is logged once and then silenced until the connection recovers
  - Outbound friend-requests on reconnect include the invite password originally supplied at add-time, so peers with invite-password auto-accept can still auto-accept even if they were offline when the friend was first added
  - 15-second handshake timeout on all outbound dials prevents hung connections from blocking the reconnect loop indefinitely
  - `[search]` timing logs added to network search initiation, forwarding, and result delivery to help diagnose latency
  - **Schema migration required:** run `bunx prisma db push` and `bunx prisma generate` to add the `remotePassword` column to the `Friend` table

- **Folder browser** — setup wizard and Settings now include a "Browse…" button next to folder path inputs; clicking it opens a modal that lets users navigate their filesystem visually and select a folder, so they never have to type a path manually; the text input remains editable for power users
  - New `GET /api/fs?path=...` endpoint lists subdirectories at a given path (hidden dirs excluded), returns `{ path, parent, home, entries }`, defaults to the user's home directory
  - `FolderPicker` component (modal with breadcrumb nav + scrollable dir list) used in shared-folder add row and download-folder input in both the setup wizard and Settings

- **Docker support** — `Dockerfile`, `docker-compose.yml`, and `docker-entrypoint.sh` for self-hosting; runs `prisma db push` on startup, persists the database in a named volume, and exposes the UI (`:3000`) and P2P (`:7734`) ports
  - `SHARED_FOLDERS` (colon-separated paths) and `DOWNLOAD_FOLDER` env vars seed the database on first launch so the setup wizard and Settings page always reflect the container's volume mounts
  - Setup wizard skips the shared-folders and download-folder steps entirely when those env vars are set — those paths are container-internal and can only be changed by editing `docker-compose.yml` and rebuilding
  - Settings → Files section displays env-controlled paths as read-only with an explanatory note; add/remove controls are hidden when the value is provided via environment variable

- **Friends-of-friends auto-accept** — when `autoAcceptFromFriendsOfFriends` is enabled in settings, incoming friend requests from unknown nodes are automatically accepted if any accepted connected peer vouches for them
  - New `friend-vouch-request` / `friend-vouch-response` wire protocol; queries are sent to all currently connected accepted peers with a 3-second timeout
  - Only responses from peers that were explicitly queried are accepted, preventing unsolicited vouch injections
  - Only accepted friends may request or respond to vouches, limiting enumeration attack surface
  - Handled symmetrically on both inbound (server WebSocket) and outbound (client WebSocket) connections

- **Metadata extraction — images, PDFs, EPUBs, and DOCX files** — extended metadata extraction to cover more file types; video metadata extraction fixed to include pixel dimensions, container format, and codec
  - Images (JPEG, PNG, WebP, HEIC, AVIF, TIFF): width, height, camera make/model, date/time via `exifr`; GPS coordinates excluded for privacy
  - PDFs: title, author, subject, keywords, page count via `pdf-parse` v2
  - EPUB ebooks: title, author, language, publisher, description, identifier, published date via `jszip` + OPF XML parsing
  - DOCX documents: title, author, description, keywords, revision via `jszip` + `docProps/core.xml` parsing
  - Video (AVI, MKV, MOV, MP4, etc.): now correctly extracts pixel width/height, container, and codec from track info (previously these were never read)
  - All extractors consolidated in `server/metadata.ts`; `server/indexer.ts` delegates to it
  - PDF, EPUB, and DOCX extractors skip files larger than 50 MB to prevent OOM during indexing
  - All string metadata fields are clamped to 500 characters; search-protocol drops oversized metadata JSON (> 4096 chars) rather than sending a corrupt truncated string

- **Upload stats per friend** — tracks `uploadCount` and `uploadTotalBytes` on each `Friend` row; incremented fire-and-forget whenever a chunk is served to an accepted peer, with in-memory deduplication so each unique file served to each peer counts as one upload; exposed as `uploads: { count, totalSize }` in `GET /api/friends` and shown on the Friends page alongside download stats

- **Active Downloads on Home dashboard** — the Home view now shows a live "Active Downloads" panel that polls every 3 s and renders compact rows (filename, progress bar, state badge, speed, ETA, source count) for any `PENDING`, `DOWNLOADING`, or `PAUSED` transfers, with a "View all" link to the Transfers page; `formatSpeed` and `formatEta` consolidated into `app/lib/api.ts` and shared between Home and Transfers views

- **Post-download scripts** — run user-defined `.ts`/`.js` scripts after each download completes; scripts receive `{ file: BunFile, stats: TransferStats }` and run sequentially in configured order; errors in one script do not block subsequent scripts
  - Settings UI: add, remove, and reorder scripts with up/down controls
  - REST API: `GET/POST /api/scripts`, `PATCH /api/scripts/:id` (reorder), `DELETE /api/scripts/:id`
  - `TransferStats` type exposed for script authors: `downloadId`, `filename`, `sha256`, `size`, `mimeType`, `durationMs`, `bytesReceived`, `maxSources`, `startedAt`, `completedAt`
  - **Schema migration required:** run `bunx prisma db push` to create the `PostDownloadScript` table

- **Listening port configuration** — configure the P2P listening port from Settings; port-forwarding instructions rendered dynamically with the chosen port number; env var `P2P_PORT` still overrides the DB value at startup
  - Setup wizard: new step 5 for port selection + port-forwarding instructions (Preferences moves to step 6)
  - **Schema migration required:** run `bunx prisma db push` to add the `listenPort` column to `Settings`

- **Online presence** — friends page shows a green dot next to connected friends (polling every 5 s); chat sidebar shows a presence dot on DM conversations whose peer is currently online

- **Dashboard download stats** — Home dashboard now shows real "Files downloaded" count and total bytes downloaded from completed transfers; Friends list shows per-friend download count and total size
  - Download counters (`downloadCount`, `downloadTotalBytes`) are denormalized onto the `Friend` row and incremented atomically when a download completes, keeping `GET /api/friends` O(friends) rather than O(completed downloads)
  - Only ACCEPTED friends receive credit; credits are deduplicated per download (a nodeId listed twice in one transfer's sources is counted only once); counters are hidden for non-ACCEPTED friends even if historical data exists (e.g. a friend later blocked)
  - **Schema migration required:** run `bunx prisma db push` to add the `downloadCount` and `downloadTotalBytes` columns to the `Friend` table

## [0.1.0] — 2026-06-03

### Added

- **Chat** — full P2P chat over encrypted WebSockets
  - Direct messages (DM) between two nodes; canonical `dm:{nodeA}:{nodeB}` conversation IDs (sorted) prevent split-history attacks
  - Group conversations with network-wide fan-out; any connected friend receives and auto-joins
  - `ChatMessageSchema` (Zod) validates all inbound peer messages; `senderNodeId` always overrides self-reported `fromNodeId` to prevent spoofing
  - Deduplication inside a DB transaction — replayed `messageId`s cannot create or bump a `Conversation` row
  - Split-pane UI (sidebar + thread + composer); own messages bubble right, peer messages left; 500 ms polling loop
  - New-group modal with ARIA dialog semantics and Escape-to-close
  - Full keyboard navigation on conversation list items (`role="button"`, Enter/Space)
  - REST API: `GET/POST /api/conversations`, `GET/POST /api/conversations/:id/messages`, `DELETE /api/conversations/:id`
  - `GET /api/me` exposes local `nodeId` to the frontend

- **Transfers** (#8) — multi-source chunk-based P2P download system
  - `Download` model; chunk-request / chunk-response / chunk-error wire protocol
  - Parallel multi-source downloading; SHA-256 chunk and whole-file verification
  - Resumable downloads; pause / resume / cancel with partial-file cleanup
  - Transfers UI: upload and download panes with progress bars, speed, remaining time, source count

- **Home dashboard** (#7) — files shared count + size, friends online/total, network size

- **Settings** (#6) — profile name, shared folders, download folder, auto-accept preferences, invite password, manual rescan trigger

- **Search** (#5) — local + network search with filename, file-type, and metadata filtering; result detail expand; network fan-out with TTL and cycle prevention

- **Friends** (#4) — friend list with accept/reject, add-friend form, remove action; password-based auto-accept

- **P2P network search** (#3) — `search-request` / `search-result` wire protocol; results delivered directly back to the requesting node

- **File indexing** (#2) — directory scanner, SHA-256 hashing, metadata extraction (audio/video), periodic background rescan, stale-entry cleanup

- **Friends system + infrastructure** (#1) — Ed25519 identity, X25519 ECDH handshake, AES-256-GCM session encryption, friend-request / friend-response protocol, Prettier, ESLint, pre-commit hooks, GitHub Actions CI
