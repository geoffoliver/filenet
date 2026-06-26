#!/bin/sh
set -e

# Start the P2P + management server in the background.
# Drizzle migrations are applied automatically at startup.
bun server/index.ts &
SERVER_PID=$!

# Forward SIGTERM/SIGINT to the server process so it can shut down cleanly.
trap 'kill $SERVER_PID 2>/dev/null; exit' TERM INT

# Start Next.js in the foreground. When it exits, the container exits.
exec bun run start
