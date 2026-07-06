#!/bin/sh
set -e

# One process now serves the UI, the management API, and the P2P protocol —
# no backgrounding/signal-forwarding dance needed for a second process.
exec bun server/index.ts
