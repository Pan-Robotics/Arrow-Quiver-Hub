CREATE TABLE `apiKeys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`droneId` text NOT NULL,
	`description` text,
	`isActive` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apiKeys_key_unique` ON `apiKeys` (`key`);--> statement-breakpoint
CREATE TABLE `appData` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appId` text NOT NULL,
	`data` text NOT NULL,
	`rawPayload` text,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `appVersions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appId` text NOT NULL,
	`version` text NOT NULL,
	`parserCode` text NOT NULL,
	`dataSchema` text NOT NULL,
	`uiSchema` text,
	`name` text NOT NULL,
	`description` text,
	`creatorId` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customApps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`appId` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`dataSource` text DEFAULT 'custom_endpoint' NOT NULL,
	`dataSourceConfig` text,
	`parserCode` text NOT NULL,
	`dataSchema` text NOT NULL,
	`uiSchema` text,
	`version` text DEFAULT '1.0.0' NOT NULL,
	`published` text DEFAULT 'draft' NOT NULL,
	`creatorId` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customApps_appId_unique` ON `customApps` (`appId`);--> statement-breakpoint
CREATE TABLE `droneFiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fileId` text NOT NULL,
	`filename` text NOT NULL,
	`mimeType` text,
	`fileSize` integer NOT NULL,
	`storageKey` text NOT NULL,
	`url` text NOT NULL,
	`droneId` text,
	`description` text,
	`uploadedBy` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `droneFiles_fileId_unique` ON `droneFiles` (`fileId`);--> statement-breakpoint
CREATE TABLE `droneJobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`errorMessage` text,
	`createdAt` integer NOT NULL,
	`acknowledgedAt` integer,
	`completedAt` integer,
	`createdBy` integer NOT NULL,
	`retryCount` integer DEFAULT 0 NOT NULL,
	`maxRetries` integer DEFAULT 3 NOT NULL,
	`timeoutSeconds` integer DEFAULT 300 NOT NULL,
	`expiresAt` integer,
	`lockedBy` text
);
--> statement-breakpoint
CREATE TABLE `drones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`name` text,
	`lastSeen` integer NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drones_droneId_unique` ON `drones` (`droneId`);--> statement-breakpoint
CREATE TABLE `fcLogs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`remotePath` text NOT NULL,
	`filename` text NOT NULL,
	`fileSize` integer,
	`status` text DEFAULT 'discovered' NOT NULL,
	`progress` integer DEFAULT 0,
	`storageKey` text,
	`url` text,
	`errorMessage` text,
	`discoveredAt` integer NOT NULL,
	`downloadedAt` integer,
	`sha256Hash` text
);
--> statement-breakpoint
CREATE TABLE `firmwareUpdates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`filename` text NOT NULL,
	`fileSize` integer NOT NULL,
	`storageKey` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`flashStage` text,
	`progress` integer DEFAULT 0,
	`errorMessage` text,
	`initiatedBy` integer,
	`createdAt` integer NOT NULL,
	`startedAt` integer,
	`completedAt` integer,
	`sha256Hash` text,
	`firmwareVersion` text
);
--> statement-breakpoint
CREATE TABLE `flightLogs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`filename` text NOT NULL,
	`fileSize` integer NOT NULL,
	`storageKey` text NOT NULL,
	`url` text NOT NULL,
	`format` text NOT NULL,
	`description` text,
	`notesUrl` text,
	`mediaUrls` text,
	`uploadSource` text DEFAULT 'manual' NOT NULL,
	`uploadedBy` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`timestamp` integer NOT NULL,
	`pointCount` integer NOT NULL,
	`minDistance` integer,
	`maxDistance` integer,
	`avgQuality` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `systemDiagnostics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`cpuPercent` integer,
	`memoryPercent` integer,
	`diskPercent` integer,
	`cpuTempC` integer,
	`uptimeSeconds` integer,
	`services` text,
	`network` text,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telemetry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`droneId` text NOT NULL,
	`timestamp` integer NOT NULL,
	`telemetryData` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `userApps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`appId` text NOT NULL,
	`installedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`openId` text NOT NULL,
	`name` text,
	`email` text,
	`loginMethod` text,
	`role` text DEFAULT 'user' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastSignedIn` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_openId_unique` ON `users` (`openId`);