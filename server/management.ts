import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Truncate a string to at most maxBytes UTF-8 bytes without splitting a
// multi-byte character. Needed because filesystem name limits are byte-based.
function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

import { and, count, desc, eq, lt, max, sum } from 'drizzle-orm';

import {
  AddFriendBodySchema,
  AddScriptBodySchema,
  FriendActionBodySchema,
  PatchSettingsBodySchema,
  ReorderScriptBodySchema,
  SearchQuerySchema,
} from './schemas';
import { ConflictError, NotFoundError } from './errors';
import {
  type ConnectedPeer,
  closeAndUnregisterPeer,
  getAcceptedConnectedPeers,
  getConnectedPeer,
  notifyFriendAccepted,
  notifyFriendRejected,
  sendToPeer,
} from './connections';
import { acceptFriendRequest, addOutgoingFriend, getFriends, rejectFriendRequest } from './friends';
import {
  cancelDownload,
  getTransfers,
  pauseDownload,
  resumeDownload,
  startDownload,
} from './download-manager';
import { cancelUploadFlushForFriend, getActiveUploadSessions } from './transfer-protocol';
import {
  conversations,
  downloads,
  friends,
  messages,
  postDownloadScripts,
  sharedFiles,
} from './schema';
import {
  getEnvConfig,
  getOrCreateSettings,
  parseSharedFolders,
  sanitizeSettings,
  updateSettings,
} from './config';
import type { Db } from './db';
import type { Identity } from './identity';
import type { SharedFile } from './schema';
import { dmConversationId } from './chat';
import { initiateNetworkSearch } from './search-protocol';
import { scanAndIndex } from './indexer';
import { searchFiles } from './search';

type SharedFileDto = {
  id: string;
  path: string;
  filename: string;
  size: string;
  sha256: string;
  mimeType: string | null;
  metadata: string | null;
  fileModifiedAt: string | null;
  indexedAt: string;
  updatedAt: string;
};

function toSharedFileDto(file: SharedFile): SharedFileDto {
  return {
    id: file.id,
    path: file.path,
    filename: file.filename,
    size: file.size.toString(),
    sha256: file.sha256,
    mimeType: file.mimeType,
    metadata: file.metadata,
    fileModifiedAt: file.fileModifiedAt?.toISOString() ?? null,
    indexedAt: file.indexedAt!.toISOString(),
    updatedAt: file.updatedAt!.toISOString(),
  };
}

export type ConnectPeerFn = (
  address: string,
  port: number,
  friendRequest?: { name: string; password?: string },
) => Promise<ConnectedPeer>;

export type ManagementDeps = {
  identity: Identity;
  db: Db;
  connectPeer: ConnectPeerFn;
  networkSearch?: typeof initiateNetworkSearch;
};

export function createManagementFetch(deps: ManagementDeps): (req: Request) => Promise<Response> {
  const { identity, db, connectPeer, networkSearch = initiateNetworkSearch } = deps;

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (url.pathname === '/api/me' && req.method === 'GET') {
        return Response.json({ nodeId: identity.nodeId });
      }

      if (url.pathname === '/api/friends') {
        if (req.method === 'GET') {
          const friendList = await getFriends(db);
          const enriched = friendList.map(
            ({
              downloadCount,
              downloadTotalBytes,
              uploadCount,
              uploadTotalBytes,
              remotePassword: _rp,
              ...f
            }) => ({
              ...f,
              online: f.nodeId ? !!getConnectedPeer(f.nodeId) : false,
              downloads:
                f.status === 'ACCEPTED'
                  ? { count: downloadCount, totalSize: String(downloadTotalBytes) }
                  : { count: 0, totalSize: '0' },
              uploads:
                f.status === 'ACCEPTED'
                  ? { count: uploadCount, totalSize: String(uploadTotalBytes) }
                  : { count: 0, totalSize: '0' },
            }),
          );
          return Response.json(enriched);
        }

        if (req.method === 'POST') {
          const result = AddFriendBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const { name, address, port, password } = result.data;
          const friend = await addOutgoingFriend(db, { name, address, port, password });
          const settingsRow = await getOrCreateSettings(db);
          Promise.resolve()
            .then(() =>
              connectPeer(address, port, {
                name: settingsRow.name.trim() || identity.nodeId,
                password,
              }),
            )
            .catch((err: unknown) => {
              console.error(`Failed to connect to ${address}:${port}:`, err);
            });
          const {
            downloadCount: _dc,
            downloadTotalBytes: _dtb,
            uploadCount: _uc,
            uploadTotalBytes: _utb,
            remotePassword: _rp2,
            ...friendData
          } = friend;
          return Response.json(
            {
              ...friendData,
              online: false,
              downloads: { count: 0, totalSize: '0' },
              uploads: { count: 0, totalSize: '0' },
            },
            { status: 201 },
          );
        }
      }

      if (url.pathname.startsWith('/api/friends/')) {
        const id = url.pathname.slice('/api/friends/'.length);
        if (!id || id.includes('/')) {
          return new Response('Invalid friend id', { status: 400 });
        }

        if (req.method === 'PUT') {
          const result = FriendActionBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const { action } = result.data;

          if (action === 'accept') {
            const pending = db.select().from(friends).where(eq(friends.id, id)).get();
            if (!pending) return new Response(`Friend ${id} not found`, { status: 404 });
            if (pending.status !== 'INCOMING_PENDING') {
              return new Response(`Cannot accept a friend with status ${pending.status}`, {
                status: 409,
              });
            }
            const updated = await acceptFriendRequest(db, id);
            const settingsRow = await getOrCreateSettings(db);
            const localName = settingsRow.name || null;
            if (updated.nodeId) {
              const peer = getConnectedPeer(updated.nodeId);
              if (peer) {
                try {
                  notifyFriendAccepted(peer, localName);
                } catch {}
              } else {
                connectPeer(updated.address, updated.port)
                  .then((p) => notifyFriendAccepted(p, localName))
                  .catch((err: unknown) => {
                    console.error(`Failed to dial back ${updated.address}:${updated.port}:`, err);
                  });
              }
            }
            const {
              downloadCount,
              downloadTotalBytes,
              uploadCount,
              uploadTotalBytes,
              remotePassword: _rp3,
              ...updatedData
            } = updated;
            return Response.json({
              ...updatedData,
              online: updated.nodeId ? !!getConnectedPeer(updated.nodeId) : false,
              downloads: { count: downloadCount, totalSize: String(downloadTotalBytes) },
              uploads: { count: uploadCount, totalSize: String(uploadTotalBytes) },
            });
          }

          if (action === 'reject') {
            const friend = db.select().from(friends).where(eq(friends.id, id)).get();
            if (!friend) return new Response(`Friend ${id} not found`, { status: 404 });
            await rejectFriendRequest(db, id);
            if (friend.nodeId) {
              const peer = getConnectedPeer(friend.nodeId);
              if (peer) {
                try {
                  notifyFriendRejected(peer);
                } catch {}
              }
              closeAndUnregisterPeer(friend.nodeId);
            }
            return new Response(null, { status: 204 });
          }
        }

        if (req.method === 'DELETE') {
          const toDelete = db.select().from(friends).where(eq(friends.id, id)).get();
          if (!toDelete) return new Response(`Friend ${id} not found`, { status: 404 });
          cancelUploadFlushForFriend(id);
          if (toDelete.nodeId) closeAndUnregisterPeer(toDelete.nodeId);
          db.delete(friends).where(eq(friends.id, id)).run();
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === '/api/fs' && req.method === 'GET') {
        const home = homedir();
        const rawPath = url.searchParams.get('path');
        if (rawPath && !isAbsolute(rawPath)) {
          return new Response('Path must be absolute', { status: 400 });
        }
        const target = resolve(rawPath || home);
        try {
          const info = await stat(target);
          if (!info.isDirectory()) return new Response('Not a directory', { status: 400 });
          const raw = await readdir(target, { withFileTypes: true });
          const entries = raw
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => ({ name: e.name, path: join(target, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
          const parentDir = dirname(target);
          const parent = parentDir === target ? null : parentDir;
          return Response.json({ path: target, parent, home, entries });
        } catch {
          return new Response('Cannot read directory', { status: 400 });
        }
      }

      if (url.pathname === '/api/settings/env' && req.method === 'GET') {
        return Response.json(getEnvConfig());
      }

      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') {
          const settingsRow = await getOrCreateSettings(db);
          return Response.json(sanitizeSettings(settingsRow));
        }

        if (req.method === 'PATCH') {
          const result = PatchSettingsBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const env = getEnvConfig();
          if (result.data.sharedFolders !== undefined && env.sharedFolders.length > 0) {
            return new Response(
              'sharedFolders is controlled by the SHARED_FOLDERS environment variable',
              { status: 409 },
            );
          }
          if (result.data.downloadFolder !== undefined && env.downloadFolder !== null) {
            return new Response(
              'downloadFolder is controlled by the DOWNLOAD_FOLDER environment variable',
              { status: 409 },
            );
          }
          const updated = await updateSettings(db, result.data);
          if (result.data.sharedFolders !== undefined) {
            // Shared folders were just (re)configured — scan them now rather
            // than waiting for the user to notice nothing is indexed and
            // find the manual "Force rescan" button. Matches the existing
            // blocking-with-spinner UX of that button; both the setup
            // wizard and Settings already show a saving/spinner state while
            // this request is in flight, so no client changes are needed.
            await scanAndIndex(db, parseSharedFolders(updated.sharedFolders));
          }
          return Response.json(sanitizeSettings(updated));
        }
      }

      if (url.pathname === '/api/search' && req.method === 'GET') {
        const result = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!result.success) {
          return new Response(result.error.issues[0].message, { status: 400 });
        }
        const { q, type, limit, offset, network } = result.data;
        const localSearchPromise = searchFiles(db, { query: q, type, limit, offset });
        const networkResultsPromise = network
          ? getAcceptedConnectedPeers(db).then((peers) =>
              networkSearch(identity, peers, { query: q, fileType: type }),
            )
          : Promise.resolve([]);
        const [localResult, networkResults] = await Promise.all([
          localSearchPromise,
          networkResultsPromise,
        ]);
        return Response.json({
          files: localResult.files.map(toSharedFileDto),
          total: localResult.total,
          ...(network ? { network: networkResults } : {}),
        });
      }

      if (url.pathname === '/api/stats' && req.method === 'GET') {
        const [fileStats, friendCount, onlineFriends, downloadStats] = await Promise.all([
          Promise.resolve(
            db
              .select({ count: count(), totalSize: sum(sharedFiles.size) })
              .from(sharedFiles)
              .get(),
          ),
          Promise.resolve(
            db.select({ count: count() }).from(friends).where(eq(friends.status, 'ACCEPTED')).get(),
          ),
          getAcceptedConnectedPeers(db),
          Promise.resolve(
            db
              .select({ count: count(), totalSize: sum(downloads.size) })
              .from(downloads)
              .where(eq(downloads.state, 'COMPLETED'))
              .get(),
          ),
        ]);
        return Response.json({
          sharedFiles: {
            count: fileStats?.count ?? 0,
            totalSize: String(fileStats?.totalSize ?? 0),
          },
          friends: {
            total: friendCount?.count ?? 0,
            online: onlineFriends.length,
          },
          downloads: {
            count: downloadStats?.count ?? 0,
            totalSize: String(downloadStats?.totalSize ?? 0),
          },
        });
      }

      if (url.pathname === '/api/transfers') {
        if (req.method === 'GET') {
          return Response.json(await getTransfers(db));
        }

        if (req.method === 'POST') {
          const body = await req.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return new Response('Invalid JSON body', { status: 400 });
          }
          const { sha256, filename, size, mimeType, sources } = body as {
            sha256: string;
            filename: string;
            size: string;
            mimeType?: string | null;
            sources: unknown[];
          };
          const trimmedSources = Array.isArray(sources)
            ? sources.map((s) => (typeof s === 'string' ? s.trim() : s))
            : sources;
          if (
            typeof sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(sha256) ||
            typeof filename !== 'string' ||
            !filename.trim() ||
            filename.trim().length > 1000 ||
            typeof size !== 'string' ||
            !/^\d+$/.test(size) ||
            !Array.isArray(trimmedSources) ||
            trimmedSources.length === 0 ||
            trimmedSources.length > 100 ||
            trimmedSources.some((s) => typeof s !== 'string' || !/^[0-9a-f]{32}$/.test(s)) ||
            (mimeType !== null && mimeType !== undefined && typeof mimeType !== 'string') ||
            (typeof mimeType === 'string' && mimeType.length > 200)
          ) {
            return new Response('Invalid transfer request', { status: 400 });
          }
          if (BigInt(size) > BigInt(Number.MAX_SAFE_INTEGER)) {
            return new Response('File size too large', { status: 400 });
          }
          const settingsRow = await getOrCreateSettings(db);
          const downloadFolder = settingsRow.downloadFolder;
          if (!downloadFolder) {
            return new Response('Download folder not configured', { status: 422 });
          }
          const id = await startDownload(db, {
            sha256,
            filename: truncateToBytes(filename.trim(), 200),
            size: BigInt(size),
            mimeType: mimeType ? mimeType.trim() || null : null,
            sources: trimmedSources as string[],
            downloadFolder,
          });
          return Response.json({ id }, { status: 201 });
        }
      }

      if (url.pathname === '/api/uploads') {
        if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
        return Response.json(getActiveUploadSessions());
      }

      if (url.pathname.startsWith('/api/transfers/')) {
        const id = url.pathname.slice('/api/transfers/'.length);
        if (!id || id.includes('/')) {
          return new Response('Invalid transfer id', { status: 400 });
        }

        if (req.method === 'PATCH') {
          const body = await req.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return new Response('Invalid JSON body', { status: 400 });
          }
          const { action } = body as { action?: string };
          if (action === 'pause') {
            const ok = await pauseDownload(db, id);
            return ok
              ? new Response(null, { status: 204 })
              : new Response('Not pausable', { status: 409 });
          }
          if (action === 'resume') {
            const ok = await resumeDownload(db, id);
            return ok
              ? new Response(null, { status: 204 })
              : new Response('Not resumable', { status: 409 });
          }
          if (action === 'cancel') {
            const ok = await cancelDownload(db, id);
            return ok
              ? new Response(null, { status: 204 })
              : new Response('Not cancellable', { status: 409 });
          }
          return new Response('Unknown action', { status: 400 });
        }

        if (req.method === 'DELETE') {
          const record = db.select().from(downloads).where(eq(downloads.id, id)).get();
          if (!record) return new Response('Not found', { status: 404 });
          if (record.state === 'DOWNLOADING' || record.state === 'PAUSED') {
            return new Response('Cannot delete an active download — cancel it first', {
              status: 409,
            });
          }
          db.delete(downloads).where(eq(downloads.id, id)).run();
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === '/api/scripts') {
        if (req.method === 'GET') {
          const scripts = db
            .select()
            .from(postDownloadScripts)
            .orderBy(postDownloadScripts.order, postDownloadScripts.id)
            .all();
          return Response.json(scripts);
        }

        if (req.method === 'POST') {
          const result = AddScriptBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const { path } = result.data;
          try {
            const script = db.transaction((tx) => {
              const agg = tx
                .select({ maxOrder: max(postDownloadScripts.order) })
                .from(postDownloadScripts)
                .get();
              const nextOrder = (agg?.maxOrder ?? -1) + 1;
              return tx
                .insert(postDownloadScripts)
                .values({ id: randomUUID(), path, order: nextOrder, createdAt: new Date() })
                .returning()
                .get();
            });
            return Response.json(script, { status: 201 });
          } catch (err) {
            if (err instanceof Error && err.message.includes('UNIQUE constraint failed'))
              return new Response('Script already exists', { status: 409 });
            throw err;
          }
        }
      }

      if (url.pathname.startsWith('/api/scripts/')) {
        const id = url.pathname.slice('/api/scripts/'.length);
        if (!id || id.includes('/')) {
          return new Response('Invalid script id', { status: 400 });
        }

        if (req.method === 'PATCH') {
          const result = ReorderScriptBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const script = db
            .select()
            .from(postDownloadScripts)
            .where(eq(postDownloadScripts.id, id))
            .get();
          if (!script) return new Response('Script not found', { status: 404 });

          const neighborRow = (() => {
            if (result.data.direction === 'up') {
              return db
                .select()
                .from(postDownloadScripts)
                .where(lt(postDownloadScripts.order, script.order))
                .orderBy(desc(postDownloadScripts.order), desc(postDownloadScripts.id))
                .get();
            }
            const all = db
              .select()
              .from(postDownloadScripts)
              .orderBy(postDownloadScripts.order, postDownloadScripts.id)
              .all();
            const idx = all.findIndex((s) => s.id === id);
            return idx >= 0 && idx < all.length - 1 ? all[idx + 1] : undefined;
          })();

          if (!neighborRow) return new Response(null, { status: 204 });

          db.transaction((tx) => {
            tx.update(postDownloadScripts)
              .set({ order: neighborRow.order })
              .where(eq(postDownloadScripts.id, script.id))
              .run();
            tx.update(postDownloadScripts)
              .set({ order: script.order })
              .where(eq(postDownloadScripts.id, neighborRow.id))
              .run();
          });

          const updated = db
            .select()
            .from(postDownloadScripts)
            .orderBy(postDownloadScripts.order, postDownloadScripts.id)
            .all();
          return Response.json(updated);
        }

        if (req.method === 'DELETE') {
          const script = db
            .select()
            .from(postDownloadScripts)
            .where(eq(postDownloadScripts.id, id))
            .get();
          if (!script) return new Response('Script not found', { status: 404 });
          db.delete(postDownloadScripts).where(eq(postDownloadScripts.id, id)).run();
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === '/api/rescan' && req.method === 'POST') {
        const settingsRow = await getOrCreateSettings(db);
        const folders = parseSharedFolders(settingsRow.sharedFolders);
        const result = await scanAndIndex(db, folders);
        if (result.skipped) {
          return new Response('Scan already in progress', { status: 409 });
        }
        return Response.json({ indexed: result.indexed, removed: result.removed });
      }

      // ── Chat ──────────────────────────────────────────────────────────────

      if (url.pathname === '/api/conversations') {
        if (req.method === 'GET') {
          const convRows = db
            .select()
            .from(conversations)
            .orderBy(desc(conversations.updatedAt))
            .all();
          const convIds = convRows.map((c) => c.id);

          // Fetch all messages for listed conversations, keep only the most recent per conv
          const allRecentMsgs =
            convIds.length > 0
              ? (() => {
                  // One query per conv is fine at this scale; conversations list is short
                  const result: Record<string, typeof messages.$inferSelect> = {};
                  for (const convId of convIds) {
                    const msg = db
                      .select()
                      .from(messages)
                      .where(eq(messages.conversationId, convId))
                      .orderBy(desc(messages.sentAt))
                      .limit(1)
                      .get();
                    if (msg) result[convId] = msg;
                  }
                  return result;
                })()
              : {};

          return Response.json(
            convRows.map((c) => ({
              ...c,
              messages: allRecentMsgs[c.id] ? [allRecentMsgs[c.id]] : [],
            })),
          );
        }

        if (req.method === 'POST') {
          const body = await req.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return new Response('Invalid JSON body', { status: 400 });
          }
          const { name, peerNodeId } = body as { name?: string; peerNodeId?: string };

          if (typeof peerNodeId === 'string' && peerNodeId.trim()) {
            const isFriend = db
              .select()
              .from(friends)
              .where(and(eq(friends.nodeId, peerNodeId.trim()), eq(friends.status, 'ACCEPTED')))
              .get();
            if (!isFriend) {
              return new Response('peerNodeId must be an accepted friend', { status: 403 });
            }
            const convId = dmConversationId(identity.nodeId, peerNodeId.trim());
            const now = new Date();
            const conv = db
              .insert(conversations)
              .values({ id: convId, type: 'DM', createdAt: now, updatedAt: now })
              .onConflictDoNothing()
              .returning()
              .get();
            const existing =
              conv ?? db.select().from(conversations).where(eq(conversations.id, convId)).get();
            const latestMsg = db
              .select()
              .from(messages)
              .where(eq(messages.conversationId, convId))
              .orderBy(desc(messages.sentAt))
              .limit(1)
              .get();
            return Response.json(
              { ...existing, messages: latestMsg ? [latestMsg] : [] },
              { status: 200 },
            );
          }

          if (typeof name !== 'string' || !name.trim()) {
            return new Response('either peerNodeId or name is required', { status: 400 });
          }
          const convId = `group:${randomUUID()}`;
          const now = new Date();
          const groupName = truncateToBytes(name.trim(), 200);
          const conv = db
            .insert(conversations)
            .values({
              id: convId,
              type: 'GROUP',
              name: groupName,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();

          try {
            const peers = await getAcceptedConnectedPeers(db);
            const groupCreateMsg = {
              type: 'group-create' as const,
              conversationId: convId,
              name: groupName,
              createdAt: now.getTime(),
            };
            for (const peer of peers) {
              try {
                sendToPeer(peer, groupCreateMsg);
              } catch {}
            }
          } catch (broadcastErr) {
            console.error('Failed to broadcast group creation:', broadcastErr);
          }

          return Response.json({ ...conv, messages: [] }, { status: 201 });
        }
      }

      if (url.pathname.startsWith('/api/conversations/')) {
        const rest = url.pathname.slice('/api/conversations/'.length);

        if (rest.endsWith('/messages') && req.method === 'GET') {
          const convId = rest.slice(0, -'/messages'.length);
          if (!convId || convId.includes('/')) {
            return new Response('Invalid conversation id', { status: 400 });
          }
          const convExists = db
            .select()
            .from(conversations)
            .where(eq(conversations.id, convId))
            .get();
          if (!convExists) return new Response('Conversation not found', { status: 404 });
          const limitParam = url.searchParams.get('limit');
          const beforeParam = url.searchParams.get('before');
          const limit = Math.max(1, Math.min(parseInt(limitParam ?? '50', 10) || 50, 200));
          let beforeDate: Date | null = null;
          if (beforeParam) {
            beforeDate = new Date(beforeParam);
            if (Number.isNaN(beforeDate.getTime())) {
              return new Response('Invalid before date', { status: 400 });
            }
          }
          const msgRows = db
            .select()
            .from(messages)
            .where(
              beforeDate
                ? and(eq(messages.conversationId, convId), lt(messages.sentAt, beforeDate))
                : eq(messages.conversationId, convId),
            )
            .orderBy(desc(messages.sentAt))
            .limit(limit)
            .all();
          return Response.json(msgRows.reverse());
        }

        if (rest.endsWith('/messages') && req.method === 'POST') {
          const convId = rest.slice(0, -'/messages'.length);
          if (!convId || convId.includes('/')) {
            return new Response('Invalid conversation id', { status: 400 });
          }
          const body = await req.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return new Response('Invalid JSON body', { status: 400 });
          }
          const { body: msgBody } = body as { body?: string };
          if (typeof msgBody !== 'string' || !msgBody.trim()) {
            return new Response('body is required', { status: 400 });
          }
          const text = msgBody.trim();
          if (text.length > 10_000) {
            return new Response('Message too long', { status: 400 });
          }

          const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get();
          if (!conv) return new Response('Conversation not found', { status: 404 });

          let dmPartnerId: string | undefined;
          if (conv.type === 'DM') {
            if (!convId.startsWith('dm:')) {
              return new Response('Invalid DM conversation id', { status: 400 });
            }
            const parts = convId.slice(3).split(':');
            dmPartnerId = parts.find((n) => n !== identity.nodeId);
            if (!dmPartnerId || dmConversationId(identity.nodeId, dmPartnerId) !== convId) {
              return new Response('Invalid DM conversation id', { status: 400 });
            }
            const isFriend = db
              .select()
              .from(friends)
              .where(and(eq(friends.nodeId, dmPartnerId), eq(friends.status, 'ACCEPTED')))
              .get();
            if (!isFriend) {
              return new Response('DM partner is no longer an accepted friend', { status: 403 });
            }
          }

          const messageId = randomUUID();
          const sentAt = new Date();
          const msg = db.transaction((tx) => {
            const created = tx
              .insert(messages)
              .values({
                id: messageId,
                conversationId: convId,
                fromNodeId: identity.nodeId,
                body: text,
                sentAt,
              })
              .returning()
              .get();
            tx.update(conversations)
              .set({ updatedAt: sentAt })
              .where(eq(conversations.id, convId))
              .run();
            return created;
          });

          const chatWireMsg = {
            type: 'chat-message' as const,
            messageId,
            conversationId: convId,
            fromNodeId: identity.nodeId,
            body: text,
            sentAt: sentAt.getTime(),
            ...(conv.name ? { conversationName: conv.name } : {}),
          };

          if (dmPartnerId) {
            const peer = getConnectedPeer(dmPartnerId);
            if (peer) {
              try {
                sendToPeer(peer, chatWireMsg);
              } catch {}
            }
          } else {
            try {
              const peers = await getAcceptedConnectedPeers(db);
              for (const peer of peers) {
                try {
                  sendToPeer(peer, chatWireMsg);
                } catch {}
              }
            } catch (broadcastErr) {
              console.error('Failed to broadcast group message:', broadcastErr);
            }
          }

          return Response.json(msg, { status: 201 });
        }

        const convId = rest;
        if (!convId || convId.includes('/')) {
          return new Response('Invalid conversation id', { status: 400 });
        }
        if (req.method === 'DELETE') {
          const conv = db.select().from(conversations).where(eq(conversations.id, convId)).get();
          if (!conv) return new Response('Conversation not found', { status: 404 });
          db.transaction((tx) => {
            tx.delete(messages).where(eq(messages.conversationId, convId)).run();
            tx.delete(conversations).where(eq(conversations.id, convId)).run();
          });
          return new Response(null, { status: 204 });
        }
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: unknown) {
      if (err instanceof NotFoundError) return new Response(err.message, { status: 404 });
      if (err instanceof ConflictError) return new Response(err.message, { status: 409 });
      if (err instanceof SyntaxError) return new Response('Invalid JSON body', { status: 400 });
      console.error('Management API error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}
