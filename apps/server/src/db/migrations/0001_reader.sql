-- Reader library. IF NOT EXISTS: the open source and company editions number this migration differently.
CREATE TABLE IF NOT EXISTS `reader_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`format` text DEFAULT 'md' NOT NULL,
	`body` text NOT NULL,
	`last_pos` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reader_docs_updated_idx` ON `reader_docs` (`updated_at`);