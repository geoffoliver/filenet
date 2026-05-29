import type { PrismaClient, SharedFile } from '@prisma/client';

import {
  AddFriendBodySchema,
  FriendActionBodySchema,
  PatchSettingsBodySchema,
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
} from './connections';
import { acceptFriendRequest, addOutgoingFriend, getFriends, rejectFriendRequest } from './friends';
import {
  cancelDownload,
  getTransfers,
  pauseDownload,
  resumeDownload,
  startDownload,
} from './download-manager';
import {
  getOrCreateSettings,
  parseSharedFolders,
  sanitizeSettings,
  updateSettings,
} from './config';
import type { Identity } from './identity';
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
    indexedAt: file.indexedAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

export type ConnectPeerFn = (
  address: string,
  port: number,
  friendRequest?: { name: string; password?: string },
) => Promise<ConnectedPeer>;

export type ManagementDeps = {
  identity: Identity;
  prisma: PrismaClient;
  connectPeer: ConnectPeerFn;
  networkSearch?: typeof initiateNetworkSearch;
};

export function createManagementFetch(deps: ManagementDeps): (req: Request) => Promise<Response> {
  const { identity, prisma, connectPeer, networkSearch = initiateNetworkSearch } = deps;

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (url.pathname === '/api/friends') {
        if (req.method === 'GET') {
          const friends = await getFriends(prisma);
          return Response.json(friends);
        }

        if (req.method === 'POST') {
          const result = AddFriendBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const { name, address, port, password } = result.data;
          const friend = await addOutgoingFriend(prisma, { name, address, port });
          const settings = await getOrCreateSettings(prisma);
          connectPeer(address, port, { name: settings.name || identity.nodeId, password }).catch(
            (err: unknown) => {
              console.error(`Failed to connect to ${address}:${port}:`, err);
            },
          );
          return Response.json(friend, { status: 201 });
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
            const pending = await prisma.friend.findUnique({ where: { id } });
            if (!pending) return new Response(`Friend ${id} not found`, { status: 404 });
            if (pending.status !== 'INCOMING_PENDING') {
              return new Response(`Cannot accept a friend with status ${pending.status}`, {
                status: 409,
              });
            }
            const updated = await acceptFriendRequest(prisma, id);
            const settings = await getOrCreateSettings(prisma);
            const localName = settings.name || null;
            if (updated.nodeId) {
              const peer = getConnectedPeer(updated.nodeId);
              if (peer) {
                try {
                  notifyFriendAccepted(peer, localName);
                } catch {
                  // peer disconnected between lookup and send
                }
              } else {
                connectPeer(updated.address, updated.port)
                  .then((p) => {
                    notifyFriendAccepted(p, localName);
                  })
                  .catch((err: unknown) => {
                    console.error(`Failed to dial back ${updated.address}:${updated.port}:`, err);
                  });
              }
            }
            return Response.json(updated);
          }

          if (action === 'reject') {
            const friend = await prisma.friend.findUnique({ where: { id } });
            if (!friend) return new Response(`Friend ${id} not found`, { status: 404 });
            await rejectFriendRequest(prisma, id);
            if (friend.nodeId) {
              const peer = getConnectedPeer(friend.nodeId);
              if (peer) {
                try {
                  notifyFriendRejected(peer);
                } catch {
                  // peer disconnected between lookup and send
                }
              }
              closeAndUnregisterPeer(friend.nodeId);
            }
            return new Response(null, { status: 204 });
          }
        }

        if (req.method === 'DELETE') {
          const toDelete = await prisma.friend.findUnique({ where: { id } });
          if (!toDelete) return new Response(`Friend ${id} not found`, { status: 404 });
          if (toDelete.nodeId) closeAndUnregisterPeer(toDelete.nodeId);
          await prisma.friend.delete({ where: { id } });
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') {
          const settings = await getOrCreateSettings(prisma);
          return Response.json(sanitizeSettings(settings));
        }

        if (req.method === 'PATCH') {
          const result = PatchSettingsBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const updated = await updateSettings(prisma, result.data);
          return Response.json(sanitizeSettings(updated));
        }
      }

      if (url.pathname === '/api/search' && req.method === 'GET') {
        const result = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!result.success) {
          return new Response(result.error.issues[0].message, { status: 400 });
        }
        const { q, type, limit, offset, network } = result.data;
        const localSearchPromise = searchFiles(prisma, { query: q, type, limit, offset });
        const networkResultsPromise = network
          ? getAcceptedConnectedPeers(prisma).then((peers) =>
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
        const [fileAgg, friendTotal, onlineFriends] = await Promise.all([
          prisma.sharedFile.aggregate({ _count: true, _sum: { size: true } }),
          prisma.friend.count({ where: { status: 'ACCEPTED' } }),
          getAcceptedConnectedPeers(prisma),
        ]);
        return Response.json({
          sharedFiles: {
            count: fileAgg._count,
            totalSize: String(fileAgg._sum.size ?? 0n),
          },
          friends: {
            total: friendTotal,
            online: onlineFriends.length,
          },
        });
      }

      if (url.pathname === '/api/transfers') {
        if (req.method === 'GET') {
          const transfers = await getTransfers(prisma);
          return Response.json(transfers);
        }

        if (req.method === 'POST') {
          const body = await req.json();
          const { sha256, filename, size, mimeType, sources } = body as {
            sha256: string;
            filename: string;
            size: string;
            mimeType?: string | null;
            sources: string[];
          };
          if (
            typeof sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(sha256) ||
            typeof filename !== 'string' ||
            !filename.trim() ||
            typeof size !== 'string' ||
            !/^\d+$/.test(size) ||
            !Array.isArray(sources) ||
            sources.length === 0 ||
            sources.some((s) => typeof s !== 'string') ||
            (mimeType !== null && mimeType !== undefined && typeof mimeType !== 'string')
          ) {
            return new Response('Invalid transfer request', { status: 400 });
          }
          if (BigInt(size) > BigInt(Number.MAX_SAFE_INTEGER)) {
            return new Response('File size too large', { status: 400 });
          }
          const settings = await getOrCreateSettings(prisma);
          const downloadFolder = settings.downloadFolder;
          if (!downloadFolder) {
            return new Response('Download folder not configured', { status: 422 });
          }
          const id = await startDownload(prisma, {
            sha256,
            filename: filename.trim(),
            size: BigInt(size),
            mimeType: mimeType ?? null,
            sources,
            downloadFolder,
          });
          return Response.json({ id }, { status: 201 });
        }
      }

      if (url.pathname.startsWith('/api/transfers/')) {
        const id = url.pathname.slice('/api/transfers/'.length);
        if (!id || id.includes('/')) {
          return new Response('Invalid transfer id', { status: 400 });
        }

        if (req.method === 'PATCH') {
          const body = await req.json();
          const { action } = body as { action?: string };
          if (action === 'pause') {
            const ok = await pauseDownload(prisma, id);
            return ok
              ? new Response(null, { status: 204 })
              : new Response('Not pausable', { status: 409 });
          }
          if (action === 'resume') {
            const ok = await resumeDownload(prisma, id);
            return ok
              ? new Response(null, { status: 204 })
              : new Response('Not resumable', { status: 409 });
          }
          if (action === 'cancel') {
            const ok = await cancelDownload(prisma, id);
            return ok
              ? new Response(null, { status: 204 })
              : new Response('Not cancellable', { status: 409 });
          }
          return new Response('Unknown action', { status: 400 });
        }

        if (req.method === 'DELETE') {
          const record = await prisma.download.findUnique({ where: { id } });
          if (!record) return new Response('Not found', { status: 404 });
          if (record.state === 'DOWNLOADING' || record.state === 'PAUSED') {
            return new Response('Cannot delete an active download — cancel it first', {
              status: 409,
            });
          }
          await prisma.download.delete({ where: { id } });
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === '/api/rescan' && req.method === 'POST') {
        const settings = await getOrCreateSettings(prisma);
        const folders = parseSharedFolders(settings.sharedFolders);
        const result = await scanAndIndex(prisma, folders);
        if (result.skipped) {
          return new Response('Scan already in progress', { status: 409 });
        }
        return Response.json({ indexed: result.indexed, removed: result.removed });
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
