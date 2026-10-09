CREATE TABLE `question_change_proposal_sources` (
	`owner_user_id` text NOT NULL,
	`qid` text NOT NULL,
	`source_generation_id` text NOT NULL,
	`source_override_version` integer NOT NULL,
	`proposal_id` text NOT NULL,
	`claimed_at` integer NOT NULL,
	PRIMARY KEY(`owner_user_id`, `qid`, `source_generation_id`, `source_override_version`),
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposal_id`) REFERENCES `question_change_proposals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_change_proposal_sources_proposal_unique` ON `question_change_proposal_sources` (`proposal_id`);
--> statement-breakpoint
UPDATE `question_change_proposals` AS `replay`
SET `status` = 'withdrawn',
    `withdrawn_at` = COALESCE(`replay`.`withdrawn_at`, `replay`.`updated_at`)
WHERE `replay`.`status` = 'submitted'
  AND EXISTS (
    SELECT 1
    FROM `question_change_proposals` AS `original`
    WHERE `original`.`owner_user_id` = `replay`.`owner_user_id`
      AND `original`.`qid` = `replay`.`qid`
      AND `original`.`source_generation_id` = `replay`.`source_generation_id`
      AND `original`.`source_override_version` = `replay`.`source_override_version`
      AND (
        `original`.`created_at` < `replay`.`created_at`
        OR (`original`.`created_at` = `replay`.`created_at` AND `original`.`rowid` < `replay`.`rowid`)
      )
  );
--> statement-breakpoint
INSERT INTO `question_change_proposal_sources` (
  `owner_user_id`, `qid`, `source_generation_id`, `source_override_version`, `proposal_id`, `claimed_at`
)
SELECT
  `proposal`.`owner_user_id`,
  `proposal`.`qid`,
  `proposal`.`source_generation_id`,
  `proposal`.`source_override_version`,
  `proposal`.`id`,
  `proposal`.`created_at`
FROM `question_change_proposals` AS `proposal`
WHERE NOT EXISTS (
  SELECT 1
  FROM `question_change_proposals` AS `earlier`
  WHERE `earlier`.`owner_user_id` = `proposal`.`owner_user_id`
    AND `earlier`.`qid` = `proposal`.`qid`
    AND `earlier`.`source_generation_id` = `proposal`.`source_generation_id`
    AND `earlier`.`source_override_version` = `proposal`.`source_override_version`
    AND (
      `earlier`.`created_at` < `proposal`.`created_at`
      OR (`earlier`.`created_at` = `proposal`.`created_at` AND `earlier`.`rowid` < `proposal`.`rowid`)
    )
);
