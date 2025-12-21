CREATE TABLE `appVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`appId` varchar(64) NOT NULL,
	`version` varchar(32) NOT NULL,
	`parserCode` text NOT NULL,
	`dataSchema` text NOT NULL,
	`uiSchema` text,
	`name` varchar(255) NOT NULL,
	`description` text,
	`creatorId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `appVersions_id` PRIMARY KEY(`id`)
);
