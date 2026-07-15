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
bun run build
bun run server
```

Open [http://localhost:3000](http://localhost:3000). On first launch the setup wizard walks you through the initial configuration.

For local development with hot reload, run the backend and the Next.js dev
server side by side instead:

```bash
bun run server   # UI + management API (:3000) + P2P (:7734)
bun run dev      # Next.js dev server with HMR (:3001)
```

Open [http://localhost:3001](http://localhost:3001) — `.env.development`
points the dev server's API calls at the backend on `:3000`.

The application runs two listeners in a single process:

| Listener   | Default | Purpose                                         |
| ---------- | ------- | ----------------------------------------------- |
| UI + API   | `:3000` | Static web UI and management API (same process) |
| P2P server | `:7734` | Encrypted WebSocket connections to peers        |

## Running as a standalone executable

If you don't want to run Docker, Filenet also ships as a standalone
executable with no external runtime dependency — no separate Node/Bun/npm
install required.

1. Download `filenet-bun-<platform>.zip` from the Releases page for your
   platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
   `windows-x64`).
2. Extract it — you'll get `filenet` (the executable), an `out/` folder
   (the UI), and a `drizzle/migrations/` folder. Keep these three together.
3. Run the executable from that folder:

   ```bash
   ./filenet
   ```

4. Open `http://localhost:3000` in a browser to finish setup.

Configuration is via environment variables, same as Docker:
`PORT` (UI + management API, default `3000`), `P2P_PORT` (default: the
listening port configured in Settings), `DATABASE_URL` (default:
`./data/filenet.db`, relative to wherever you run the executable from).

To build these yourself: `bun run build:binaries` (requires Bun, plus
`bash`, `zip`, and a SHA-256 tool (`sha256sum` or `shasum`) on your PATH —
all standard on macOS/Linux; on Windows, run it under WSL or Git Bash).

Filenet checks for new releases automatically (interval configurable in
Settings, default once every 24 hours — set to `0` to disable), downloads
and SHA-256-verifies them in the background, and shows a **Restart to
update** button in Settings once one is ready. Forks can point their users
at their own releases by setting the "Update repository" field in Settings
(`owner/repo`, default `geoffoliver/filenet`).

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

> ⚠️ **Forward only the P2P port.** Never expose the web UI (port 3000) to the
> internet — it has no authentication and grants full control of the
> application, including browsing the host filesystem, to anyone who can reach
> it. The UI is meant for your home network only.

## Security

All peer-to-peer communication is encrypted at the application layer:

- **Key exchange**: X25519 ECDH, with both sides signing via their Ed25519 identity key — neither side can be impersonated
- **Session encryption**: AES-256-GCM with a unique key and random IV per message — covers chat, search, friend requests, and file chunks
- **Identity**: your node ID is the SHA-256 of your public key, so it's cryptographically bound to your keypair

The transport is plain `ws://`, not `wss://` (TLS). A network observer can see which IPs are talking to each other, but cannot read the content of any messages. If you need to hide the fact of communication (not just its content), run Filenet behind a VPN or [Tailscale](https://tailscale.com).

The local database (SQLite) is **not** encrypted at rest. Anyone with filesystem access to the machine can read chat history, the file index, and friend lists.

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

The app uses Drizzle ORM with SQLite. Migrations are applied automatically at startup. To generate a new migration after changing `server/schema.ts`:

```bash
bunx drizzle-kit generate
```

Test databases are created automatically by the test suite and cleaned up afterwards.
