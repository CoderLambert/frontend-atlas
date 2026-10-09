ALTER TABLE `question_private_overrides` ADD `generation_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `question_private_overrides` SET `generation_id` = lower(hex(randomblob(16))) WHERE `generation_id` = '';
