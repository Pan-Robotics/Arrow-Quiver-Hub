CREATE TABLE `telemetry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`droneId` varchar(64) NOT NULL,
	`timestamp` timestamp NOT NULL,
	`telemetryData` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `telemetry_id` PRIMARY KEY(`id`)
);
