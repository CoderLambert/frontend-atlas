CREATE TABLE `question_change_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`qid` text NOT NULL,
	`source_generation_id` text NOT NULL,
	`source_override_version` integer NOT NULL,
	`base_content_version` text NOT NULL,
	`title` text NOT NULL,
	`explanation_markdown` text NOT NULL,
	`checkpoints_json` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`withdrawn_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "question_change_proposals_status_check" CHECK("question_change_proposals"."status" in ('submitted', 'withdrawn'))
);
--> statement-breakpoint
CREATE INDEX `question_change_proposals_owner_qid_created_idx` ON `question_change_proposals` (`owner_user_id`,`qid`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `question_change_proposals_owner_qid_active_unique` ON `question_change_proposals` (`owner_user_id`,`qid`) WHERE "question_change_proposals"."status" = 'submitted';