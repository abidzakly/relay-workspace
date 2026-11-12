CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`secrets_enc` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `settings_updated_idx` ON `settings` (`updated_at`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text,
	`type` text,
	`assignees` text DEFAULT '[]' NOT NULL,
	`estimation_start` text,
	`estimation_end` text,
	`branch_name` text,
	`parent_id` text,
	`url` text,
	`notion_created_at` integer,
	`last_edited_at` integer NOT NULL,
	`assigned_at_first_seen` integer,
	`assigned_at_approx` integer DEFAULT false NOT NULL,
	`assigned_at_manual` integer,
	`assigned_at_property` text,
	`assigned_to_me` integer DEFAULT false NOT NULL,
	`product_domain` text,
	`point` real,
	`sprint` text,
	`sub_task_ids` text DEFAULT '[]' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cards_status_idx` ON `cards` (`status`);--> statement-breakpoint
CREATE INDEX `cards_parent_idx` ON `cards` (`parent_id`);--> statement-breakpoint
CREATE INDEX `cards_branch_idx` ON `cards` (`branch_name`);--> statement-breakpoint
CREATE INDEX `cards_last_edited_idx` ON `cards` (`last_edited_at`);--> statement-breakpoint
CREATE INDEX `cards_sprint_idx` ON `cards` (`sprint`);--> statement-breakpoint
CREATE TABLE `branch_pushes` (
	`repo_id` text NOT NULL,
	`branch` text NOT NULL,
	`sha` text NOT NULL,
	`pushed_at` integer NOT NULL,
	`actor` text,
	`commits` text,
	`notified_sha` text,
	PRIMARY KEY(`repo_id`, `branch`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_uuid` text NOT NULL,
	`repo_id` text NOT NULL,
	`event_type` text NOT NULL,
	`object_kind` text,
	`action` text,
	`payload` text,
	`status` text DEFAULT 'received' NOT NULL,
	`error` text,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "events_status_chk" CHECK("events"."status" in ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_event_uuid_unique` ON `events` (`event_uuid`);--> statement-breakpoint
CREATE INDEX `events_repo_received_idx` ON `events` (`repo_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `events_received_idx` ON `events` (`received_at`);--> statement-breakpoint
CREATE TABLE `mr_commits` (
	`repo_id` text NOT NULL,
	`iid` integer NOT NULL,
	`head_sha` text NOT NULL,
	`shas` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `iid`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mrs` (
	`repo_id` text NOT NULL,
	`iid` integer NOT NULL,
	`gitlab_id` integer,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`has_conflicts` integer DEFAULT false NOT NULL,
	`source_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`author` text,
	`web_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`merged_at` integer,
	`description_notion_id` text,
	`approved_by` text DEFAULT '[]' NOT NULL,
	`assignees` text DEFAULT '[]' NOT NULL,
	`reviewers` text DEFAULT '[]' NOT NULL,
	`last_note_at` integer,
	`head_pipeline` text,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `iid`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mrs_state_chk" CHECK("mrs"."state" in ('opened', 'closed', 'locked', 'merged'))
);
--> statement-breakpoint
CREATE INDEX `mrs_repo_state_idx` ON `mrs` (`repo_id`,`state`);--> statement-breakpoint
CREATE INDEX `mrs_repo_merged_idx` ON `mrs` (`repo_id`,`merged_at`);--> statement-breakpoint
CREATE INDEX `mrs_source_branch_idx` ON `mrs` (`repo_id`,`source_branch`);--> statement-breakpoint
CREATE INDEX `mrs_desc_notion_idx` ON `mrs` (`description_notion_id`);--> statement-breakpoint
CREATE TABLE `notes_cache` (
	`repo_id` text NOT NULL,
	`mr_iid` integer NOT NULL,
	`note_id` integer NOT NULL,
	`discussion_id` text NOT NULL,
	`author` text,
	`body` text DEFAULT '' NOT NULL,
	`system` integer DEFAULT false NOT NULL,
	`resolvable` integer DEFAULT false NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`seen` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`repo_id`, `note_id`),
	FOREIGN KEY (`repo_id`,`mr_iid`) REFERENCES `mrs`(`repo_id`,`iid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notes_mr_created_idx` ON `notes_cache` (`repo_id`,`mr_iid`,`created_at`);--> statement-breakpoint
CREATE INDEX `notes_discussion_idx` ON `notes_cache` (`repo_id`,`mr_iid`,`discussion_id`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`mr_iid` integer NOT NULL,
	`match_by` text NOT NULL,
	`conflict` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`,`mr_iid`) REFERENCES `mrs`(`repo_id`,`iid`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "links_match_by_chk" CHECK("links"."match_by" in ('title', 'description', 'both', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `links_card_idx` ON `links` (`card_id`);--> statement-breakpoint
CREATE INDEX `links_mr_idx` ON `links` (`repo_id`,`mr_iid`);--> statement-breakpoint
CREATE UNIQUE INDEX `links_card_mr_uq` ON `links` (`card_id`,`repo_id`,`mr_iid`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`before` text,
	`after` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`undo_token` text,
	`undone_at` integer,
	`batch_id` text,
	`undo_of` integer,
	CONSTRAINT "audit_actor_chk" CHECK("audit_log"."actor" in ('user', 'system', 'webhook'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_undo_token_unique` ON `audit_log` (`undo_token`);--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_batch_idx` ON `audit_log` (`batch_id`);--> statement-breakpoint
CREATE TABLE `job_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`log` text DEFAULT '' NOT NULL,
	`output` text,
	`error` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "job_steps_status_chk" CHECK("job_steps"."status" in ('pending', 'running', 'paused', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `job_steps_job_idx` ON `job_steps` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_steps_job_seq_uq` ON `job_steps` (`job_id`,`seq`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`kind` text NOT NULL,
	`engine` text DEFAULT 'node' NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`current_step` text,
	`version` text,
	`prev_version` text,
	`branch` text,
	`mr_iid` integer,
	`flavor` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`error` text,
	`parent_job_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "jobs_kind_chk" CHECK("jobs"."kind" in ('release', 'build')),
	CONSTRAINT "jobs_engine_chk" CHECK("jobs"."engine" in ('node', 'pty')),
	CONSTRAINT "jobs_mode_chk" CHECK("jobs"."mode" in ('staging', 'prod', 'custom')),
	CONSTRAINT "jobs_status_chk" CHECK("jobs"."status" in ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `jobs_repo_created_idx` ON `jobs` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_parent_idx` ON `jobs` (`parent_job_id`);--> statement-breakpoint
CREATE TABLE `ai_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`template` text NOT NULL,
	`engine` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cockpit_attachments` (
	`group` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gamification` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gamification_dedupe_key_unique` ON `gamification` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `gamification_kind_at_idx` ON `gamification` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `health_dismissals` (
	`key` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`card_id` text,
	`repo_id` text,
	`mr_iid` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kpi_snapshots` (
	`month` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`frozen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`url` text NOT NULL,
	`repo_id` text,
	`subject` text,
	`at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notifications_at_idx` ON `notifications` (`at`);--> statement-breakpoint
CREATE INDEX `notifications_read_at_idx` ON `notifications` (`read_at`);--> statement-breakpoint
CREATE TABLE `push_subs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subs_endpoint_unique` ON `push_subs` (`endpoint`);--> statement-breakpoint
CREATE TABLE `review_decks` (
	`deck_id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text DEFAULT '' NOT NULL,
	`diff_sha` text NOT NULL,
	`cards` text NOT NULL,
	`ai` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_decks_source_key_unique` ON `review_decks` (`source_key`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`abs_path` text NOT NULL,
	`repo_id` text,
	`default_base` text DEFAULT 'main' NOT NULL,
	`color` text DEFAULT 'amber' NOT NULL,
	`created_at` integer NOT NULL,
	`kind` text DEFAULT 'repo' NOT NULL,
	`parent_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_abs_path_unique` ON `workspaces` (`abs_path`);--> statement-breakpoint
CREATE TABLE `ac_checks` (
	`card_id` text NOT NULL,
	`target` text NOT NULL,
	`state` text NOT NULL,
	`by` text NOT NULL,
	`run_id` text,
	`verified_sha` text,
	`note` text DEFAULT '' NOT NULL,
	`evidence_path` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`card_id`, `target`),
	CONSTRAINT "ac_checks_state_ck" CHECK("ac_checks"."state" in ('untested', 'pass', 'fail', 'blocked', 'excused')),
	CONSTRAINT "ac_checks_by_ck" CHECK("ac_checks"."by" in ('human', 'ai'))
);
--> statement-breakpoint
CREATE TABLE `card_bodies` (
	`card_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`last_edited_at` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`figma_override` text,
	`frames` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_bench_sessions` (
	`repo_id` text NOT NULL,
	`branch` text NOT NULL,
	`card_id` text NOT NULL,
	`card_title` text NOT NULL,
	`opened_at` integer NOT NULL,
	`dismissed_at` integer,
	PRIMARY KEY(`repo_id`, `branch`)
);
--> statement-breakpoint
CREATE TABLE `test_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`branch` text NOT NULL,
	`title` text NOT NULL,
	`severity` text NOT NULL,
	`ac_key` text,
	`steps` text DEFAULT '' NOT NULL,
	`expected` text DEFAULT '' NOT NULL,
	`actual` text DEFAULT '' NOT NULL,
	`screenshot_path` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`fix_commit_sha` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "test_findings_severity_ck" CHECK("test_findings"."severity" in ('blocker', 'major', 'minor', 'cosmetic')),
	CONSTRAINT "test_findings_status_ck" CHECK("test_findings"."status" in ('open', 'fixing', 'fixed', 'verified', 'wontfix')),
	CONSTRAINT "test_findings_source_ck" CHECK("test_findings"."source" in ('human', 'ai'))
);
--> statement-breakpoint
CREATE INDEX `test_findings_card_idx` ON `test_findings` (`card_id`);--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`verdict` text,
	`summary` text DEFAULT '' NOT NULL,
	`waiting_for` text,
	`device_serial` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	CONSTRAINT "test_runs_mode_ck" CHECK("test_runs"."mode" in ('manual', 'ai')),
	CONSTRAINT "test_runs_status_ck" CHECK("test_runs"."status" in ('active', 'paused', 'done', 'aborted')),
	CONSTRAINT "test_runs_verdict_ck" CHECK("test_runs"."verdict" in ('ready', 'not_ready'))
);
--> statement-breakpoint
CREATE INDEX `test_runs_branch_idx` ON `test_runs` (`repo_id`,`branch`);