ALTER TABLE `droneJobs` MODIFY COLUMN `status` enum('pending','in_progress','completed','failed','expired') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `droneJobs` ADD `retryCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `droneJobs` ADD `maxRetries` int DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `droneJobs` ADD `timeoutSeconds` int DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE `droneJobs` ADD `expiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `droneJobs` ADD `lockedBy` varchar(128);--> statement-breakpoint
ALTER TABLE `fcLogs` ADD `sha256Hash` varchar(64);--> statement-breakpoint
ALTER TABLE `firmwareUpdates` ADD `sha256Hash` varchar(64);