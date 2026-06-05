# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Post-download scripts** — run user-defined `.ts`/`.js` scripts after each download completes; scripts receive `{ file: BunFile, stats: TransferStats }` and run sequentially in configured order; errors in one script do not block subsequent scripts
  - Settings UI: add, remove, and reorder scripts with up/down controls
  - REST API: `GET/POST /api/scripts`, `PATCH /api/scripts/:id` (reorder), `DELETE /api/scripts/:id`
  - `TransferStats` type exposed for script authors: `downloadId`, `filename`, `sha256`, `size`, `mimeType`, `durationMs`, `bytesReceived`, `maxSources`, `startedAt`, `completedAt`
  - **Schema migration required:** run `bunx prisma db push` to create the `PostDownloadScript` table

- **Listening port configuration** — configure the P2P listening port from Settings; port-forwarding instructions rendered dynamically with the chosen port number; env var `P2P_PORT` still overrides the DB value at startup
  - Setup wizard: new step 5 for port selection + port-forwarding instructions (Preferences moves to step 6)
  - **Schema migration required:** run `bunx prisma db push` to add the `listenPort` column to `Settings`

- **Online presence** — friends page shows a green dot next to connected friends (polling every 5 s); chat sidebar shows a presence dot on DM conversations whose peer is currently online

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
