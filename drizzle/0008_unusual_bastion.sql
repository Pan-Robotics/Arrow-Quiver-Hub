CREATE TABLE `flightLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`fileSize` int NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`url` varchar(1024) NOT NULL,
	`format` enum('bin','log') NOT NULL,
	`description` text,
	`notesUrl` varchar(1024),
	`mediaUrls` json,
	`uploadSource` enum('manual','api') NOT NULL DEFAULT 'manual',
	`uploadedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `flightLogs_id` PRIMARY KEY(`id`)
);
