FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Next.js UI
EXPOSE 3000
# P2P WebSocket (matches Settings.listenPort default)
EXPOSE 7734

ENV PORT=3000
ENV MGMT_PORT=7735
ENV DATABASE_URL=file:./data/filenet.db

ENTRYPOINT ["docker-entrypoint.sh"]
