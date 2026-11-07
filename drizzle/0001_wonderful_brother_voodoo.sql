ALTER TABLE `drones` ADD `ingestMode` text DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE `drones` ADD `tailnetHost` text;--> statement-breakpoint
ALTER TABLE `drones` ADD `streamPort` integer DEFAULT 8765 NOT NULL;