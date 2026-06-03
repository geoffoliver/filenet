import { z } from 'zod';

const portSchema = z
  .int()
  .min(1, 'port must be between 1 and 65535')
  .max(65535, 'port must be between 1 and 65535');

// HTTP request body schemas

export const AddFriendBodySchema = z.object({
  name: z.string().trim().min(1, 'name must be a non-empty string').max(200),
  address: z.string().trim().min(1, 'address must be a non-empty string').max(253),
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
  q: z.string().max(500).optional().default(''),
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
  size: z.string().max(20).regex(/^\d+$/, 'size must be a non-negative integer string'),
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
  ttl: z.number().int().min(1).max(10),
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

const sha256Schema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters');

export const ChunkRequestMessageSchema = z.object({
  type: z.literal('chunk-request'),
  transferId: z.string().uuid(),
  sha256: sha256Schema,
  offset: z.number().int().min(0),
  length: z
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024), // max 4 MB per chunk
});

export const ChunkResponseMessageSchema = z.object({
  type: z.literal('chunk-response'),
  transferId: z.string().uuid(),
  sha256: sha256Schema,
  offset: z.number().int().min(0),
  data: z.string().max(6 * 1024 * 1024), // base64 of up to 4 MB
});

export const ChunkErrorMessageSchema = z.object({
  type: z.literal('chunk-error'),
  transferId: z.string().uuid(),
  sha256: sha256Schema,
  offset: z.number().int().min(0),
  reason: z.string().max(500),
});

export const ChatMessageSchema = z.object({
  type: z.literal('chat-message'),
  messageId: z.string().uuid(),
  conversationId: z
    .string()
    .max(500)
    .regex(
      /^(dm:|group:)[-a-zA-Z0-9:._~]+$/,
      'conversationId must be dm: or group: followed by URL-safe path characters',
    ),
  fromNodeId: z.string().max(200).min(1),
  body: z
    .string()
    .min(1)
    .max(10_000)
    .refine((v) => v.trim().length > 0, 'body must not be blank'),
  sentAt: z.number().int().min(1).max(8_640_000_000_000_000), // max valid JS Date timestamp
  conversationName: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() || undefined : v),
    z.string().min(1).max(200).optional(),
  ),
});

export const FriendResponseMessageSchema = z.object({
  type: z.literal('friend-response'),
  accepted: z.boolean(),
  name: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() || undefined : v),
    z.string().max(200).optional(),
  ),
});
