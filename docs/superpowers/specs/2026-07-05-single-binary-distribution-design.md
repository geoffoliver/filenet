# Single-Binary Distribution — Design

## Goal

Ship Filenet as a standalone executable (à la Sonarr/Radarr) with no external
runtime dependency (no separate Node/Bun/npm install), for users who don't
want to run Docker. Docker remains a fully supported, unchanged-in-spirit
deployment path alongside it.

## Current state

- Next.js (`next dev` / `next start`) serves the UI and, via
  `app/api/[...path]/route.ts`, blindly proxies every `/api/*` request to a
  second Bun process — a management REST API bound to `127.0.0.1:7735`
  (`server/management.ts`, wired up in `server/index.ts`).
- A separate public `Bun.serve` handles the P2P WebSocket protocol
  (`/pubkey`, `/health`, and the encrypted P2P handshake) on a
  user-configurable, router-forwarded port.
- The frontend (`app/`) is already 100% client components: no middleware, no
  `next/image`, no server-side `redirect()`, no dynamic route segments. This
  makes it a strong fit for Next's static export mode.

## Security note (resolves a question raised during design)

The `127.0.0.1:7735` binding on the management API does **not** currently add
real security: the Next.js proxy forwards any request to it with zero
authentication, so anyone who can reach the public UI port today already has
full management API access (friends, filesystem browsing via `/api/fs`,
post-download scripts, transfers). Folding the management handler into the
same process as the UI server does not change this exposure — it removes a
redundant network hop within the same trust boundary, not a security
boundary. Adding real auth to this port is a valid future improvement but is
explicitly **out of scope** for this project (see Scope below).

The **P2P port** is a different matter — it's the one users are told to
forward through their router to the open internet. It must **not** gain the
management API; only the UI port does.

## Architecture after this change

One process (`server/index.ts`) runs two listeners:

1. **P2P port** (unchanged) — WebSocket P2P protocol, `/pubkey`, `/health`.
   Still the one users port-forward.
2. **UI port** (was Next's `PORT`, e.g. 3000) — a new unified server that:
   - Serves static files from Next's exported `out/` directory.
   - Handles `/api/*` by calling the existing `createManagementFetch`
     handler in-process (function call, not an HTTP round-trip).
   - In non-production mode only, allows CORS from the configured dev
     origin.

The standalone `127.0.0.1:7735` management `Bun.serve` and the `MGMT_PORT`
env var are removed entirely — nothing needs them once Next's proxy is gone.

## Frontend changes

- `next.config.ts`: add `output: 'export'`.
- Delete `app/api/[...path]/route.ts`. Next's static-export docs are explicit
  that Route Handlers relying on `Request` (headers/body) are unsupported —
  and that attempting to use them (or `rewrites()`/`redirects()`/`headers()`,
  which are also unsupported) errors even under `next dev`, not just
  `next build`. So this file cannot be conditionally kept for dev only; it
  must go away in all environments.
- `app/lib/api.ts`: change every `fetch('/api/...')` call to use a base URL
  from `NEXT_PUBLIC_API_BASE_URL` (default `''`, i.e. same-origin, correct
  for the production static build served by the unified server). No changes
  to function signatures or return types.
- **Dev workflow**: `.env.development` sets
  `NEXT_PUBLIC_API_BASE_URL=http://localhost:3000` (the unified server's
  port). Run `bun run dev` (Next dev server, HMR on its own port) alongside
  `bun run server` (the unified UI+API+P2P server) for full-stack local
  dev — cross-origin instead of today's same-origin, with CORS allowed by
  the unified server only outside production.

## Server changes

- New module, e.g. `server/ui-server.ts`, exporting a `createUiServer()`
  that serves static files from `out/` (correct content-types, `index.html`
  / `404.html` fallback matching Next's static-export file layout) and
  routes `/api/*` to `createManagementFetch` in-process.
- `server/index.ts`: replace the standalone management `Bun.serve` (port
  `MGMT_PORT`, `127.0.0.1`-only) with `Bun.serve({ port: PORT, ... })` using
  `createUiServer()`. `MGMT_PORT` is removed. `PORT` (already used today by
  Next/Docker) becomes the UI+API port. P2P port handling is unchanged.
- `DATABASE_URL` default stays `./data/filenet.db` (relative to cwd) —
  unchanged behavior.

## Docker changes

Docker keeps running from source (`bun server/index.ts`), not the compiled
binary.

- `Dockerfile`: build stage still runs `bun run build`, now producing `out/`
  instead of `.next/`; final stage copies `out/` instead of `.next/`; the
  `MGMT_PORT` env/`EXPOSE` line is removed.
- `docker-entrypoint.sh` simplifies from "background the P2P/mgmt process,
  trap and forward signals, foreground-exec `bun run start`" (two processes)
  down to a single `exec bun server/index.ts` (one process, signals go
  straight to it, no trap/backgrounding needed).

## Build/packaging

- New `package.json` script(s) to compile per target using
  `bun build --compile --target=<bun-target> --outfile dist/<target>/filenet
server/index.ts`, for: `bun-linux-x64`, `bun-linux-arm64`,
  `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`.
- Release artifact shape is **binary + assets folder**, not a single opaque
  file — this matches how Sonarr/Radarr actually ship despite the
  "single-binary" framing, and avoids needing extra codegen tooling to
  enumerate and statically import Next's variable, hashed-filename export
  output and Drizzle's migration SQL files into the compiled binary itself:

  ```
  filenet-linux-x64.tar.gz
  ├── filenet          (compiled executable)
  ├── out/             (static UI, from `next build`)
  └── drizzle/
      └── migrations/  (SQL files)
  ```

## Testing & verification

- Playwright e2e: unaffected. Every `/api/*` call is already mocked via
  `page.route()` in-browser before hitting the network, and tests run
  against `next dev`, which is unaffected by `output: 'export'` (a
  build-time concern) once the proxy route is gone.
- Backend Bun tests: unaffected — management handler logic doesn't change,
  only how it's invoked (in-process call vs. HTTP round-trip).
- New: a test for `createUiServer()` covering both a static asset request
  and an `/api/*` request routed in-process.
- Manual verification before calling this done: run
  `next build && bun server/index.ts`, load the UI in a real browser, and
  exercise a couple of real flows end-to-end (settings load, a search).
  Also compile and run at least one binary target standalone.

## Scope

**In scope:** static export + unified UI/API server + Docker adjustments +
manual `bun build --compile` packaging for all five targets, verified
working.

**Out of scope (separate future work):**

- Wiring binary builds into CI / automating releases — that's the next TODO
  item ("GitHub Actions release workflow").
- Adding real authentication to the UI/management port — a pre-existing gap,
  not introduced by this change, explicitly deferred.
