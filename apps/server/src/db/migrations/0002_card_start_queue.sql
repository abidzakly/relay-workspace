CREATE TABLE `card_start_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`parent_card_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`error_code` text,
	`session_id` text,
	`started_workspace_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `card_start_queue_parent_idx` ON `card_start_queue` (`parent_card_id`);