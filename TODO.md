# Filenet — TODO

## Core / Server

### Identity & Crypto

- [x] Ed25519 keypair generation and persistence (Prisma/SQLite)
- [x] Node ID derivation (SHA-256 of public key)
- [x] Public key HTTP endpoint (`GET /pubkey`) — unauthenticated
- [x] Sign / verify (Ed25519)
- [x] Ephemeral X25519 ECDH key exchange
- [x] Session key derivation (HKDF)
- [x] AES-256-GCM encrypt / decrypt
- [x] Mutual-auth WebSocket handshake (hello → hello-ack → ready)
- [x] Bun WebSocket server entry point (`server/index.ts`)

### Friends

- [x] Prisma schema: `Friend` model with `OUTGOING_PENDING` / `INCOMING_PENDING` / `ACCEPTED` / `BLOCKED` statuses
- [x] Prisma schema: `Settings` model (name, invitePassword, autoAcceptFromAnyone, autoAcceptFromFriendsOfFriends)
- [x] Outbound connection: connect to a peer by address + port, complete handshake as initiator
- [x] Send `friend-request` message over encrypted connection
- [x] Receive and store incoming friend requests (pending state)
- [x] Accept / reject friend request
- [x] Password-based auto-accept (skip confirmation if correct password provided)
- [x] Auto-accept settings: from anyone / password / off
- [x] Persist friend's node ID and public key once connected
- [x] Remove a friend
- [x] Management HTTP API: `GET/POST /api/friends`, `PUT /api/friends/:id`, `DELETE /api/friends/:id`, `GET/PATCH /api/settings`
- [ ] Auto-accept from friends-of-friends (requires routing layer)
- [ ] Fetch peer's public key on first contact (`GET /pubkey`) — currently skipped (key exchanged in handshake)

### File Indexing

- [x] Prisma schema: `SharedFile` model (filename, path, size, SHA-256, mime type, metadata JSON, indexed at)
- [x] Configurable shared folder(s) stored in DB / config
- [x] Directory scanner: walk folders, hash files, upsert index
- [x] Metadata extraction — audio/video (artist, album, track, duration, bitrate, etc.) via music-metadata
- [ ] Metadata extraction — ebook, document, and image metadata (not yet implemented)
- [x] Detect changed files (mtime / size delta before re-hashing)
- [x] Periodic background rescan (configurable interval)
- [x] Manual rescan trigger (API endpoint)
- [x] Remove stale index entries for deleted files

### Search

- [x] Local search (filename, file type, metadata fields)
- [x] Outbound search: fan out to all connected friends with a search ID + TTL
- [x] Inbound search: execute locally, forward to own friends (minus already-seen search IDs), return results directly to originating node
- [x] Search deduplication (track seen search IDs to prevent cycles)
- [x] Direct result delivery back to the requesting node over an encrypted connection

### File Transfers

- [x] Prisma schema: `Download` model (file hash, chunks, sources, state, progress)
- [x] Chunk-based download protocol (request/serve specific byte ranges; 1 MB chunks, 4 concurrent, 30s timeout)
- [x] Multi-source downloading (same file from multiple peers simultaneously)
- [x] SHA-256 verification of completed chunks and whole file
- [x] Resumable downloads (persist chunk state to DB)
- [x] Pause / resume / cancel download
- [x] Serve file chunks to requesting peers (upload side)
- [x] Transfer stats: speed, remaining time, bytes transferred, source count
- [x] Post-download script execution (run user scripts in order, pass `BunFile` + `TransferStats`)

### Chat

- [x] Prisma schema: `Conversation` (DM / GROUP) and `Message` models
- [x] One-on-one encrypted messaging over authenticated connection; canonical `dm:{nodeA}:{nodeB}` IDs prevent split-history
- [x] Persist message history indefinitely (delete on user request via `DELETE /api/conversations/:id`)
- [x] Group chat: conversation creation, name propagated to all peers via wire message
- [x] Group chat: fan-out to all accepted connected peers on send
- [x] `ChatMessageSchema` (Zod) validates inbound peer messages; deduplication + atomic transaction
- [x] Online presence: track which friends are currently connected

### API (Next.js → P2P server bridge)

- [x] Management REST API on `127.0.0.1:7735` (localhost-only, no CORS)
- [x] Next.js catch-all proxy (`/api/[...path]`) forwarding UI requests to P2P server
- [x] Settings endpoints: `GET/PATCH /api/settings`
- [x] Search endpoint: `GET /api/search` (local + network)
- [x] Expose remaining endpoints as features are built: friends, transfers, chat, stats

---

## UI (Next.js)

### Shell

- [x] Global layout: sticky navbar + main content area
- [x] Navbar: Home, Search, Chat, Friends, Transfers, Settings links
- [x] Navbar: search field (enter/click → navigate to Search + run query)
- [x] Client-side routing between sections (SPA, no full-page reloads)
- [x] CSS module + global stylesheet scaffolding (variables, resets, base styles)

### Setup Wizard

- [x] First-launch detection (no profile configured → redirect to `/setup`)
- [x] Step 1: Welcome
- [x] Step 2: Display name
- [x] Step 3: Shared folders
- [x] Step 4: Download folder
- [x] Step 5: Auto-accept preferences + invite password
- [x] Progress bar + back/skip/next/finish navigation
- [x] Step: listening port + port-forwarding instructions
- [ ] Extended profile fields (email, picture, bio, links) — deferred to Settings
- [ ] Maybe: native folder-browser component (API-backed directory listing) to replace manual path input in shared folders + download folder steps

### Home (Dashboard)

- [x] Files shared count + total size
- [x] Friends online / total
- [ ] Files downloaded count + total size (deferred — needs transfer tracking)
- [ ] Total bytes uploaded/downloaded (deferred — needs transfer tracking)
- [ ] Active transfers overview (deferred — needs transfer system)

### Search

- [x] Search form: text input + file-type dropdown (All, Audio, Video, Image, Document, Ebook)
- [x] Trigger search on enter / button click (also auto-runs from navbar)
- [x] Network search always on (removed opt-in toggle — network search is the whole point)
- [x] Results list: filename, size, mime type, source count (local + network merged by sha256)
- [x] Result detail expand: full metadata, hash preview, "on this node" badge
- [x] Download button placeholder (disabled until transfer system exists)

### Chat

- [x] Split-pane layout (sidebar + thread + composer)
- [x] Left pane: DM list + group list, sorted by most recent activity
- [x] Right pane: message thread, newest at bottom; own messages bubble right
- [x] Message input + send (Enter to send, Shift+Enter for newline)
- [x] Create new group chat via modal (ARIA dialog, Escape to close)
- [x] Delete conversation (with confirmation)
- [x] 500 ms polling loop; scroll-to-bottom only on new messages

### Friends

- [x] Friend list: name, avatar (initials), friendship duration
- [x] Pending incoming requests with accept / reject actions
- [x] Add Friend form: name, address, port, optional password
- [x] Remove friend action (with inline confirmation)
- [ ] Friend list: shared file count, download/upload totals (deferred — needs transfer tracking)

### Transfers

- [x] Split-pane: uploads (top) + downloads (bottom)
- [x] Upload row: filename, progress bar, speed, time remaining, bytes transferred (auto-dismiss on completion)
- [x] Download row: filename, progress bar, speed, time remaining, bytes transferred, source count
- [x] Download controls: pause, resume, cancel (in-progress only)
- [x] Cancel confirmation + partial file cleanup
- [x] Manual dismiss of completed downloads
- [x] Completed downloads locked (no cancel — script may have moved file)

### Settings

- [x] Profile details form (name only for now; email, picture, bio, links deferred)
- [x] Shared folders: add / remove paths
- [x] Download folder picker
- [x] Auto-accept toggles + invite password
- [x] Force rescan button
- [x] Listening port field + port-forwarding instructions
- [x] Post-download scripts: add path, reorder, remove

---

## Infrastructure

- [x] Pre-commit hooks: lint + format check (Prettier / ESLint via lint-staged + husky)
- [x] GitHub Actions: run tests on push / PR
- [ ] GitHub Actions: release workflow (bump version, tag `v#.#.#`, publish)
- [ ] Playwright frontend tests (deferred — add once UI pages have real interactions)
- [ ] Improve backend test coverage as features are added
- [x] CHANGELOG (start and maintain)
- [x] README: installation, configuration, running, scripting API docs
