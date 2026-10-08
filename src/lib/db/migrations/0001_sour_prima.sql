CREATE TABLE `coach_assistant_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`client_run_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`,`conversation_id`) REFERENCES `coach_conversations`(`owner_user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`,`conversation_id`,`user_message_id`) REFERENCES `coach_messages`(`owner_user_id`,`conversation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`,`conversation_id`,`assistant_message_id`) REFERENCES `coach_messages`(`owner_user_id`,`conversation_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "coach_assistant_runs_status_check" CHECK("coach_assistant_runs"."status" in ('pending', 'streaming', 'complete', 'interrupted', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `coach_assistant_runs_owner_conversation_created_idx` ON `coach_assistant_runs` (`owner_user_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `coach_assistant_runs_owner_client_id_unique` ON `coach_assistant_runs` (`owner_user_id`,`client_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `coach_messages_owner_conversation_id_unique` ON `coach_messages` (`owner_user_id`,`conversation_id`,`id`);