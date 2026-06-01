// Pre-handshake messages (plaintext)

export type HelloMessage = {
  type: 'hello';
  nodeId: string;
  publicKey: string; // base64 SPKI Ed25519
  ephemeralKey: string; // base64 SPKI X25519
  nonce: string; // base64 random bytes
};

export type HelloAckMessage = {
  type: 'hello-ack';
  nodeId: string;
  publicKey: string; // base64 SPKI Ed25519
  ephemeralKey: string; // base64 SPKI X25519
  nonce: string; // base64 random bytes
  // sign(initiator_nonce || receiver_nonce, receiver_identity_key)
  signature: string; // base64
};

// Post-handshake messages (encrypted with AES-256-GCM session key)

export type ReadyMessage = {
  type: 'ready';
  // sign(initiator_nonce || receiver_nonce, initiator_identity_key)
  signature: string; // base64
};

export type PingMessage = {
  type: 'ping';
  timestamp: number;
};

export type PongMessage = {
  type: 'pong';
  timestamp: number;
};

export type FriendRequestMessage = {
  type: 'friend-request';
  name: string;
  port: number;
  password?: string;
};

export type FriendResponseMessage = {
  type: 'friend-response';
  accepted: boolean;
  name?: string;
};

export type SearchResultItem = {
  filename: string;
  size: string; // BigInt serialized as string
  sha256: string;
  mimeType: string | null;
  metadata: string | null;
};

export type SearchRequestMessage = {
  type: 'search-request';
  searchId: string; // UUID
  originNodeId: string;
  query: string;
  fileType: string;
  ttl: number;
};

export type SearchResultMessage = {
  type: 'search-result';
  searchId: string;
  // Producer attribution — self-reported by the originating node and relayed verbatim.
  // NOT authenticated by intermediate relays; treat as untrusted unless verified by other means.
  fromNodeId: string;
  // Authenticated immediate sender: set by the *receiving* node from the transport-layer peer
  // identity, so this field IS trusted for the direct hop but not for the full chain.
  viaNodeId?: string;
  results: SearchResultItem[];
};

export type ChatMessage = {
  type: 'chat-message';
  messageId: string; // UUID — used for deduplication
  conversationId: string; // dm:{nodeA}:{nodeB} (sorted) | group:{uuid}
  fromNodeId: string;
  body: string;
  sentAt: number; // unix ms
  conversationName?: string; // group display name, helps receiver create the conversation
};

export type ChunkRequestMessage = {
  type: 'chunk-request';
  transferId: string; // UUID, routes response back to waiting promise
  sha256: string;
  offset: number;
  length: number;
};

export type ChunkResponseMessage = {
  type: 'chunk-response';
  transferId: string;
  sha256: string;
  offset: number;
  data: string; // base64-encoded bytes
};

export type ChunkErrorMessage = {
  type: 'chunk-error';
  transferId: string;
  sha256: string;
  offset: number;
  reason: string;
};

export type InnerMessage =
  | ReadyMessage
  | PingMessage
  | PongMessage
  | FriendRequestMessage
  | FriendResponseMessage
  | SearchRequestMessage
  | SearchResultMessage
  | ChunkRequestMessage
  | ChunkResponseMessage
  | ChunkErrorMessage
  | ChatMessage;

export type WireMessage = HelloMessage | HelloAckMessage | { type: 'encrypted'; payload: string };

// Public key endpoint response
export type PubKeyResponse = {
  nodeId: string;
  publicKey: string; // base64 SPKI Ed25519
};
