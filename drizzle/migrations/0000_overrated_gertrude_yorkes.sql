CREATE TABLE `Conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text DEFAULT 'DM' NOT NULL,
	`name` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `Download` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`mimeType` text,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`bytesReceived` integer DEFAULT 0 NOT NULL,
	`chunkSize` integer DEFAULT 1048576 NOT NULL,
	`completedChunks` text DEFAULT '[]' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`tmpPath` text,
	`downloadFolder` text,
	`finalPath` text,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`completedAt` integer
);
--> statement-breakpoint
CREATE TABLE `Friend` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`nodeId` text,
	`address` text NOT NULL,
	`port` integer DEFAULT 7734 NOT NULL,
	`publicKey` text,
	`status` text DEFAULT 'OUTGOING_PENDING' NOT NULL,
	`addedAt` integer NOT NULL,
	`acceptedAt` integer,
	`updatedAt` integer NOT NULL,
	`remotePassword` text,
	`downloadCount` integer DEFAULT 0 NOT NULL,
	`downloadTotalBytes` integer DEFAULT 0 NOT NULL,
	`uploadCount` integer DEFAULT 0 NOT NULL,
	`uploadTotalBytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Friend_nodeId_unique` ON `Friend` (`nodeId`);--> statement-breakpoint
CREATE UNIQUE INDEX `Friend_address_port_unique` ON `Friend` (`address`,`port`);--> statement-breakpoint
CREATE TABLE `Identity` (
	`id` text PRIMARY KEY NOT NULL,
	`nodeId` text NOT NULL,
	`publicKey` text NOT NULL,
	`privateKey` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Identity_nodeId_unique` ON `Identity` (`nodeId`);--> statement-breakpoint
CREATE TABLE `Message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`fromNodeId` text NOT NULL,
	`body` text NOT NULL,
	`sentAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `Message_conversationId_sentAt_idx` ON `Message` (`conversationId`,`sentAt`);--> statement-breakpoint
CREATE TABLE `PostDownloadScript` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`order` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PostDownloadScript_path_unique` ON `PostDownloadScript` (`path`);--> statement-breakpoint
CREATE TABLE `Settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`invitePassword` text,
	`autoAcceptFromAnyone` integer DEFAULT false NOT NULL,
	`autoAcceptFromFriendsOfFriends` integer DEFAULT false NOT NULL,
	`sharedFolders` text DEFAULT '[]' NOT NULL,
	`downloadFolder` text,
	`rescanIntervalMinutes` integer DEFAULT 0 NOT NULL,
	`listenPort` integer DEFAULT 7734 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `SharedFile` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`mimeType` text,
	`metadata` text,
	`fileModifiedAt` integer,
	`lastSeenAt` integer NOT NULL,
	`indexedAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `SharedFile_path_unique` ON `SharedFile` (`path`);