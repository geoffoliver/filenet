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
- [x] Metadata extraction — audio (artist, album, track, duration, bitrate), video (duration, chapters), ebook, documents
- [x] Detect changed files (mtime / size delta before re-hashing)
- [ ] Periodic background rescan (configurable interval)
- [x] Manual rescan trigger (API endpoint)
- [x] Remove stale index entries for deleted files

### Search

- [ ] Local search (filename, file type, metadata fields)
- [ ] Outbound search: fan out to all connected friends with a search ID + TTL
- [ ] Inbound search: execute locally, forward to own friends (minus already-seen search IDs), return results directly to originating node
- [ ] Search deduplication (track seen search IDs to prevent cycles)
- [ ] Configurable degrees of separation (friends / friends-of-friends / everyone)
- [ ] Direct result delivery back to the requesting node over an encrypted connection

### File Transfers

- [ ] Prisma schema: `Download` model (file hash, chunks, sources, state, progress)
- [ ] Chunk-based download protocol (request/serve specific byte ranges)
- [ ] Multi-source downloading (same file from multiple peers simultaneously)
- [ ] SHA-256 verification of completed chunks and whole file
- [ ] Resumable downloads (persist chunk state to DB)
- [ ] Pause / resume / cancel download
- [ ] Serve file chunks to requesting peers (upload side)
- [ ] Transfer stats: speed, remaining time, bytes transferred, source count
- [ ] Post-download script execution (run user scripts in order, pass `BunFile` + `TransferStats`)

### Chat

- [ ] Prisma schema: `ChatMessage`, `ChatRoom`, `ChatMember` models
- [ ] One-on-one encrypted messaging over authenticated connection
- [ ] Persist one-on-one message history indefinitely (delete on user request)
- [ ] Group chat: room creation, room metadata shared across network
- [ ] Group chat: room owner rebroadcasts messages to all members
- [ ] Group chat: message history stored until user leaves room
- [ ] Online presence: track which friends are currently connected

### Configuration

- [ ] Prisma schema (or config file): store all user settings
- [ ] Profile: name, email, picture, bio, links
- [ ] Shared folder(s) management (add / remove paths)
- [ ] Download folder path
- [ ] Listening port (default 7734)
- [ ] Auto-accept friend request rules
- [ ] Degrees-of-separation setting
- [ ] Post-download scripts list (paths + order)

### API (Next.js → P2P server bridge)

- [ ] Local management WebSocket or REST API so the Next.js UI can control the P2P server
- [ ] Expose: friend list, friend requests, search, transfers, chat, settings, stats

---

## UI (Next.js)

### Shell

- [ ] Global layout: sticky navbar + main content area
- [ ] Navbar: Home, Search, Chat, Friends, Transfers, Settings links
- [ ] Navbar: search field (enter/click → navigate to Search + run query)
- [ ] Client-side routing between sections (SPA, no full-page reloads)
- [ ] CSS module + global stylesheet scaffolding (variables, resets, base styles)

### Setup Wizard

- [ ] First-launch detection (no profile configured)
- [ ] Step: profile details (name, email, picture, bio, links)
- [ ] Step: shared folders
- [ ] Step: download folder
- [ ] Step: listening port + port-forwarding instructions
- [ ] Step: auto-accept and degrees-of-separation preferences
- [ ] Sensible defaults pre-filled throughout

### Home (Dashboard)

- [ ] Files shared count + total size
- [ ] Files downloaded count + total size
- [ ] Total bytes uploaded
- [ ] Network size (approximate node count reachable)
- [ ] Friends currently online
- [ ] Active transfers overview (mini list)

### Search

- [ ] Search form: text input + file-type dropdown (All, Audio, Video, Ebook, Document, …)
- [ ] Trigger search on enter / button click
- [ ] Results list: filename, size, file type, source count
- [ ] Result detail expand: full metadata, per-source availability
- [ ] Download button per result

### Chat

- [ ] Split-pane layout
- [ ] Left pane: online friends list + group chat / room list
- [ ] Right pane: message thread (newest at bottom)
- [ ] Message input + send
- [ ] Create new group chat / room
- [ ] Messages persist for lifetime of the page (in-memory, not re-fetched)

### Friends

- [ ] Friend list: name, avatar, friendship duration, shared file count, download/upload totals
- [ ] Pending incoming requests with accept / reject actions
- [ ] Add Friend form: name, address, port, optional password
- [ ] Remove friend action (with confirmation)

### Transfers

- [ ] Split-pane: uploads (top) + downloads (bottom)
- [ ] Upload row: filename, progress bar, speed, time remaining, bytes transferred (auto-dismiss on completion)
- [ ] Download row: filename, progress bar, speed, time remaining, bytes transferred, source count
- [ ] Download controls: pause, resume, cancel (in-progress only)
- [ ] Cancel confirmation + partial file cleanup
- [ ] Manual dismiss of completed downloads
- [ ] Completed downloads locked (no cancel — script may have moved file)

### Settings

- [ ] Profile details form
- [ ] Shared folders: add / remove paths
- [ ] Download folder picker
- [ ] Listening port field + port-forwarding instructions
- [ ] Auto-accept toggles
- [ ] Degrees-of-separation selector
- [ ] Post-download scripts: add path, reorder, remove
- [ ] Force rescan button

---

## Infrastructure

- [x] Pre-commit hooks: lint + format check (Prettier / ESLint via lint-staged + husky)
- [x] GitHub Actions: run tests on push / PR
- [ ] GitHub Actions: release workflow (bump version, tag `v#.#.#`, publish)
- [ ] Playwright frontend tests
- [ ] Improve backend test coverage as features are added
- [ ] CHANGELOG (start and maintain)
- [ ] README: installation, configuration, running, scripting API docs
