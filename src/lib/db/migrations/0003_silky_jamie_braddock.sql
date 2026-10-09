CREATE TABLE `coach_provider_bindings` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`siwc_client_id` text NOT NULL,
	`selected_model` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coach_provider_bindings_siwc_client_id_unique` ON `coach_provider_bindings` (`siwc_client_id`);--> statement-breakpoint
ALTER TABLE `coach_assistant_runs` ADD `provider_model` text;--> statement-breakpoint
ALTER TABLE `coach_assistant_runs` ADD `provider_binding_version` integer;