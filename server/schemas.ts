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
  })
  .strict();

// Protocol message schemas (untrusted peer input)

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
