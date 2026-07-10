ALTER TABLE `Settings` ADD `updateRepo` text DEFAULT 'geoffoliver/filenet' NOT NULL;--> statement-breakpoint
ALTER TABLE `Settings` ADD `updateCheckIntervalMinutes` integer DEFAULT 1440 NOT NULL;