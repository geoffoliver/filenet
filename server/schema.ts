import {
  customType,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// SQLite INTEGER is 64-bit; bun:sqlite accepts BigInt natively for integer columns.
const bigInt = customType<{ data: bigint; driverData: number | bigint }>({
  dataType() {
    return 'integer';
  },
  fromDriver(val) {
    if (typeof val === 'bigint') return val;
    if (!Number.isSafeInteger(val as number))
      throw new Error(`bigint column received unsafe integer ${val} — value would be lossy`);
    return BigInt(val as number);
  },
  toDriver(val) {
    return val;
  },
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const identity = sqliteTable('Identity', {
  id: text('id').primaryKey(),
  nodeId: text('nodeId').notNull().unique(),
  publicKey: text('publicKey').notNull(),
  privateKey: text('privateKey').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
});

// ---------------------------------------------------------------------------
// Friend
// ---------------------------------------------------------------------------

export type FriendStatus = 'OUTGOING_PENDING' | 'INCOMING_PENDING' | 'ACCEPTED' | 'BLOCKED';

export const friends = sqliteTable(
  'Friend',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nodeId: text('nodeId').unique(),
    address: text('address').notNull(),
    port: integer('port').notNull().default(7734),
    publicKey: text('publicKey'),
    status: text('status').notNull().default('OUTGOING_PENDING').$type<FriendStatus>(),
    addedAt: integer('addedAt', { mode: 'timestamp_ms' }).notNull(),
    acceptedAt: integer('acceptedAt', { mode: 'timestamp_ms' }),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
    remotePassword: text('remotePassword'),
    downloadCount: integer('downloadCount').notNull().default(0),
    downloadTotalBytes: bigInt('downloadTotalBytes')
      .notNull()
      .default(0 as unknown as bigint),
    uploadCount: integer('uploadCount').notNull().default(0),
    uploadTotalBytes: bigInt('uploadTotalBytes')
      .notNull()
      .default(0 as unknown as bigint),
  },
  (t) => [uniqueIndex('Friend_address_port_unique').on(t.address, t.port)],
);

export type Friend = typeof friends.$inferSelect;
export type NewFriend = typeof friends.$inferInsert;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settings = sqliteTable('Settings', {
  id: text('id').primaryKey().default('singleton'),
  name: text('name').notNull().default(''),
  invitePassword: text('invitePassword'),
  autoAcceptFromAnyone: integer('autoAcceptFromAnyone', { mode: 'boolean' })
    .notNull()
    .default(false),
  autoAcceptFromFriendsOfFriends: integer('autoAcceptFromFriendsOfFriends', { mode: 'boolean' })
    .notNull()
    .default(false),
  sharedFolders: text('sharedFolders').notNull().default('[]'),
  downloadFolder: text('downloadFolder'),
  rescanIntervalMinutes: integer('rescanIntervalMinutes').notNull().default(0),
  listenPort: integer('listenPort').notNull().default(7734),
  updateRepo: text('updateRepo').notNull().default('geoffoliver/filenet'),
  updateCheckIntervalMinutes: integer('updateCheckIntervalMinutes').notNull().default(1440),
});

export type Settings = typeof settings.$inferSelect;

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type DownloadState =
  | 'PENDING'
  | 'DOWNLOADING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export const downloads = sqliteTable('Download', {
  id: text('id').primaryKey(),
  sha256: text('sha256').notNull(),
  filename: text('filename').notNull(),
  size: bigInt('size').notNull(),
  mimeType: text('mimeType'),
  state: text('state').notNull().default('PENDING').$type<DownloadState>(),
  bytesReceived: bigInt('bytesReceived')
    .notNull()
    .default(0 as unknown as bigint),
  chunkSize: integer('chunkSize').notNull().default(1048576),
  completedChunks: text('completedChunks').notNull().default('[]'),
  sources: text('sources').notNull().default('[]'),
  tmpPath: text('tmpPath'),
  downloadFolder: text('downloadFolder'),
  finalPath: text('finalPath'),
  error: text('error'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completedAt', { mode: 'timestamp_ms' }),
});

export type Download = typeof downloads.$inferSelect;

// ---------------------------------------------------------------------------
// Conversation + Message
// ---------------------------------------------------------------------------

export type ConvType = 'DM' | 'GROUP';

export const conversations = sqliteTable('Conversation', {
  id: text('id').primaryKey(),
  type: text('type').notNull().default('DM').$type<ConvType>(),
  name: text('name'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
});

export type Conversation = typeof conversations.$inferSelect;

export const messages = sqliteTable(
  'Message',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversationId')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    fromNodeId: text('fromNodeId').notNull(),
    body: text('body').notNull(),
    sentAt: integer('sentAt', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('Message_conversationId_sentAt_idx').on(t.conversationId, t.sentAt)],
);

export type Message = typeof messages.$inferSelect;

// ---------------------------------------------------------------------------
// SharedFile
// ---------------------------------------------------------------------------

export const sharedFiles = sqliteTable('SharedFile', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  filename: text('filename').notNull(),
  size: bigInt('size').notNull(),
  sha256: text('sha256').notNull(),
  mimeType: text('mimeType'),
  metadata: text('metadata'),
  fileModifiedAt: integer('fileModifiedAt', { mode: 'timestamp_ms' }),
  lastSeenAt: integer('lastSeenAt', { mode: 'timestamp_ms' }).notNull(),
  indexedAt: integer('indexedAt', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
});

export type SharedFile = typeof sharedFiles.$inferSelect;

// ---------------------------------------------------------------------------
// PostDownloadScript
// ---------------------------------------------------------------------------

export const postDownloadScripts = sqliteTable('PostDownloadScript', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  order: integer('order').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
});

export type PostDownloadScript = typeof postDownloadScripts.$inferSelect;
