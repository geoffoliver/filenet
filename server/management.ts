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
};

export function createManagementFetch(deps: ManagementDeps): (req: Request) => Promise<Response> {
  const { identity, prisma, connectPeer } = deps;

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
        const acceptedPeers = network ? await getAcceptedConnectedPeers(prisma) : [];
        const [localResult, networkResults] = await Promise.all([
          searchFiles(prisma, { query: q, type, limit, offset }),
          network
            ? initiateNetworkSearch(identity, acceptedPeers, { query: q, fileType: type })
            : Promise.resolve([]),
        ]);
        return Response.json({
          files: localResult.files.map(toSharedFileDto),
          total: localResult.total,
          network: networkResults,
        });
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
