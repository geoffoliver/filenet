PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_Message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`fromNodeId` text NOT NULL,
	`body` text NOT NULL,
	`sentAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_Message`("id", "conversationId", "fromNodeId", "body", "sentAt") SELECT "id", "conversationId", "fromNodeId", "body", "sentAt" FROM `Message`;--> statement-breakpoint
DROP TABLE `Message`;--> statement-breakpoint
ALTER TABLE `__new_Message` RENAME TO `Message`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `Message_conversationId_sentAt_idx` ON `Message` (`conversationId`,`sentAt`);