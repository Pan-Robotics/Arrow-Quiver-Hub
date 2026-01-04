CREATE TABLE `droneFiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fileId` varchar(64) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`mimeType` varchar(128),
	`fileSize` int NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`url` varchar(1024) NOT NULL,
	`droneId` varchar(64),
	`description` text,
	`uploadedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `droneFiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `droneFiles_fileId_unique` UNIQUE(`fileId`)
);
--> statement-breakpoint
CREATE TABLE `droneJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`type` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('pending','in_progress','completed','failed') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`acknowledgedAt` timestamp,
	`completedAt` timestamp,
	`createdBy` int NOT NULL,
	CONSTRAINT `droneJobs_id` PRIMARY KEY(`id`)
);
