# Filenet

A self-hosted, peer-to-peer file sharing and chat application. Users maintain a list of friends and connect to them directly — no central server. All communication (chat, searches, file transfers) happens over encrypted WebSockets.

## Features

- **Friends** — add friends by address/port with optional invite passwords; auto-accept rules
- **File indexing** — scans shared folders, extracts metadata (audio/video), periodic background rescans
- **Search** — searches your entire network; results flow directly back from each node
- **File transfers** — chunk-based multi-source downloads (BitTorrent-style), resumable, SHA-256 verified
- **Chat** — direct messages and group conversations over the encrypted P2P connection
- **Post-download scripts** — run custom JS/TS after a download completes

## Requirements

- [Bun](https://bun.sh) ≥ 1.0

## Installation

```bash
git clone https://github.com/geoffoliver/filenet.git
cd filenet
bun install
bunx prisma db push
```

## Running

### Docker (recommended for self-hosting)

```bash
# Edit docker-compose.yml to set your shared folder path, then:
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000). The database is persisted in the `filenet-data` Docker volume. Forward port `7734` on your router to allow peers to connect.

### Manual

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000). On first launch the setup wizard walks you through the initial configuration.

The application runs two servers:

| Server         | Default | Purpose                                    |
| -------------- | ------- | ------------------------------------------ |
| Next.js        | `:3000` | Web UI + API proxy                         |
| P2P server     | `:7734` | Encrypted WebSocket connections to peers   |
| Management API | `:7735` | Localhost-only REST API consumed by the UI |

## Configuration

All settings are available in the **Settings** page of the UI:

- **Name** — your display name shared with friends
- **Shared folders** — directories whose contents are indexed and shared
- **Download folder** — where downloaded files are saved
- **Auto-accept** — automatically accept friend requests from anyone, or require a password
- **Invite password** — peers who supply this password are auto-accepted
- **Rescan interval** — how often to re-index shared folders (0 = manual only)
- **Port** — the port peers connect to (default 7734); you must forward this port on your router

### Port forwarding

Filenet requires a manually forwarded port — there is no automatic NAT traversal. To allow peers to connect to you:

1. Find your router's admin interface (usually `192.168.1.1` or `192.168.0.1`)
2. Look for "Port Forwarding" or "Virtual Server"
3. Forward **TCP port 7734** (or your configured port) to your machine's local IP address
4. Share your **public IP address** (or a domain name pointing to it) with friends

## Post-download scripts

Scripts run in order after a download completes. Each script is a TypeScript/JavaScript file with a default export:

```typescript
import type { BunFile } from 'bun';

interface TransferStats {
  downloadTimeMs: number;
  bytesTransferred: number;
  maxSources: number;
}

export default async function ({ file, stats }: { file: BunFile; stats: TransferStats }) {
  // file  — the downloaded BunFile
  // stats — transfer statistics
  console.log(`Downloaded ${file.name} in ${stats.downloadTimeMs}ms`);
}
```

Add script paths in **Settings → Scripts** and reorder them. Scripts receive the file as a `BunFile` — if a script moves or renames the file, subsequent scripts in the chain receive the updated path.

## Development

```bash
# Run tests
bun test

# Lint
bun run lint

# Format
bun run format

# Build
bun run build
```

### Database

The app uses Prisma with SQLite. After changing `prisma/schema.prisma`:

```bash
bunx prisma db push        # apply to dev DB
bunx prisma generate       # regenerate client
```

Test databases are created automatically by the test suite and cleaned up afterwards.
