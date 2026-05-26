import { z } from 'zod';

const portSchema = z
  .int()
  .min(1, 'port must be between 1 and 65535')
  .max(65535, 'port must be between 1 and 65535');

// HTTP request body schemas

export const AddFriendBodySchema = z.object({
  name: z.string().trim().min(1, 'name must be a non-empty string'),
  address: z.string().trim().min(1, 'address must be a non-empty string'),
  port: portSchema.optional().default(7734),
  password: z.string().optional(),
});

export const FriendActionBodySchema = z.object({
  action: z.enum(['accept', 'reject']),
});

export const PatchSettingsBodySchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    invitePassword: z.string().nullable().optional(),
    autoAcceptFromAnyone: z.boolean().optional(),
    autoAcceptFromFriendsOfFriends: z.boolean().optional(),
    sharedFolders: z.array(z.string().trim().min(1)).optional(),
    downloadFolder: z.string().trim().min(1).nullable().optional(),
    rescanIntervalMinutes: z.int().min(0).max(35791).optional(),
  })
  .strict();

const coerceInt = (v: unknown) => {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v.trim() : String(v);
  return s === '' ? undefined : Number(s);
};

export const SearchQuerySchema = z.object({
  q: z.string().optional().default(''),
  type: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['all', 'audio', 'video', 'image', 'document', 'ebook']).optional().default('all'),
  ),
  limit: z.preprocess(coerceInt, z.int().min(1).max(200).optional().default(50)),
  offset: z.preprocess(coerceInt, z.int().min(0).optional().default(0)),
  network: z.preprocess((v) => v === 'true' || v === true, z.boolean().optional().default(false)),
});

// Protocol message schemas (untrusted peer input)

export const SearchResultItemSchema = z.object({
  filename: z.string().max(1000),
  size: z.string().regex(/^\d+$/, 'size must be a non-negative integer string'),
  sha256: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/),
  mimeType: z.string().max(200).nullable(),
  metadata: z.string().max(4096).nullable(),
});

export const SearchRequestMessageSchema = z.object({
  type: z.literal('search-request'),
  searchId: z.string().uuid(),
  originNodeId: z.string().max(200),
  query: z.string().max(500),
  fileType: z.string().max(50),
  // min(0): ttl=0 is valid on the wire so terminal-hop forwards (decremented from 1)
  // are not rejected as malformed; the ttl<=0 guard in handleSearchRequest drops them.
  ttl: z.number().int().min(0).max(10),
});

export const SearchResultMessageSchema = z.object({
  type: z.literal('search-result'),
  searchId: z.string().uuid(),
  fromNodeId: z.string().max(200),
  viaNodeId: z.string().max(200).optional(),
  results: z.array(SearchResultItemSchema).max(200),
});

export const FriendRequestMessageSchema = z.object({
  type: z.literal('friend-request'),
  name: z.string().trim().min(1),
  port: portSchema,
  password: z.string().optional(),
});

export const FriendResponseMessageSchema = z.object({
  type: z.literal('friend-response'),
  accepted: z.boolean(),
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() || undefined : v),
    z.string().max(200).optional(),
  ),
});
