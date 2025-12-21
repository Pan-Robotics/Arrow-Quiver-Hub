CREATE TABLE `appData` (
	`id` int AUTO_INCREMENT NOT NULL,
	`appId` varchar(64) NOT NULL,
	`data` json NOT NULL,
	`rawPayload` json,
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `appData_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `userApps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`appId` varchar(64) NOT NULL,
	`installedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `userApps_id` PRIMARY KEY(`id`)
);
