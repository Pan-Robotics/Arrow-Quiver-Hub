CREATE TABLE `apiKeys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`key` varchar(64) NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`description` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `apiKeys_id` PRIMARY KEY(`id`),
	CONSTRAINT `apiKeys_key_unique` UNIQUE(`key`)
);
--> statement-breakpoint
CREATE TABLE `drones` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`name` text,
	`lastSeen` timestamp NOT NULL DEFAULT (now()),
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `drones_id` PRIMARY KEY(`id`),
	CONSTRAINT `drones_droneId_unique` UNIQUE(`droneId`)
);
--> statement-breakpoint
CREATE TABLE `scans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`timestamp` timestamp NOT NULL,
	`pointCount` int NOT NULL,
	`minDistance` int,
	`maxDistance` int,
	`avgQuality` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `scans_id` PRIMARY KEY(`id`)
);
