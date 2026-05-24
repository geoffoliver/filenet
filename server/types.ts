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

export type InnerMessage =
  | ReadyMessage
  | PingMessage
  | PongMessage
  | FriendRequestMessage
  | FriendResponseMessage;

export type WireMessage = HelloMessage | HelloAckMessage | { type: 'encrypted'; payload: string };

// Public key endpoint response
export type PubKeyResponse = {
  nodeId: string;
  publicKey: string; // base64 SPKI Ed25519
};
