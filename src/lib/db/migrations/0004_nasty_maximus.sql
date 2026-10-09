CREATE TABLE `question_private_overrides` (
	`owner_user_id` text NOT NULL,
	`qid` text NOT NULL,
	`base_content_version` text NOT NULL,
	`title` text NOT NULL,
	`explanation_markdown` text NOT NULL,
	`checkpoints_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_user_id`, `qid`),
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `question_private_overrides_owner_updated_idx` ON `question_private_overrides` (`owner_user_id`,`updated_at`);