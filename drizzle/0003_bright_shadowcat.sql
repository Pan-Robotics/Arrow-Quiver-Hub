CREATE TABLE `customApps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`appId` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`icon` varchar(512),
	`parserCode` text NOT NULL,
	`dataSchema` text NOT NULL,
	`uiSchema` text,
	`version` varchar(32) NOT NULL DEFAULT '1.0.0',
	`published` enum('draft','published') NOT NULL DEFAULT 'draft',
	`creatorId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customApps_id` PRIMARY KEY(`id`),
	CONSTRAINT `customApps_appId_unique` UNIQUE(`appId`)
);
