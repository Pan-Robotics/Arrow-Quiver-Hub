CREATE TABLE `fcLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`remotePath` varchar(512) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`fileSize` int,
	`status` enum('discovered','downloading','uploading','completed','failed') NOT NULL DEFAULT 'discovered',
	`progress` int DEFAULT 0,
	`storageKey` varchar(512),
	`url` varchar(1024),
	`errorMessage` text,
	`discoveredAt` timestamp NOT NULL DEFAULT (now()),
	`downloadedAt` timestamp,
	CONSTRAINT `fcLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `firmwareUpdates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`fileSize` int NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`url` varchar(1024) NOT NULL,
	`status` enum('uploaded','queued','transferring','flashing','verifying','completed','failed') NOT NULL DEFAULT 'uploaded',
	`flashStage` varchar(64),
	`progress` int DEFAULT 0,
	`errorMessage` text,
	`initiatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	CONSTRAINT `firmwareUpdates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `systemDiagnostics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`cpuPercent` int,
	`memoryPercent` int,
	`diskPercent` int,
	`cpuTempC` int,
	`uptimeSeconds` int,
	`services` json,
	`network` json,
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `systemDiagnostics_id` PRIMARY KEY(`id`)
);
