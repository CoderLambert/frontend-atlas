PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__question_change_proposal_sources_backup` (
	`owner_user_id` text NOT NULL,
	`qid` text NOT NULL,
	`source_generation_id` text NOT NULL,
	`source_override_version` integer NOT NULL,
	`proposal_id` text NOT NULL,
	`claimed_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__question_change_proposal_sources_backup`
SELECT `owner_user_id`, `qid`, `source_generation_id`, `source_override_version`, `proposal_id`, `claimed_at`
FROM `question_change_proposal_sources`;--> statement-breakpoint
DROP TABLE `question_change_proposal_sources`;--> statement-breakpoint
CREATE TABLE `__new_question_change_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`qid` text NOT NULL,
	`source_generation_id` text NOT NULL,
	`source_override_version` integer NOT NULL,
	`base_content_version` text NOT NULL,
	`base_content_sha256` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`explanation_markdown` text NOT NULL,
	`checkpoints_json` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`withdrawn_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "question_change_proposals_status_check" CHECK("__new_question_change_proposals"."status" in ('submitted', 'withdrawn', 'approved', 'rejected', 'published'))
);
--> statement-breakpoint
INSERT INTO `__new_question_change_proposals`(
  "id", "owner_user_id", "qid", "source_generation_id", "source_override_version",
  "base_content_version", "base_content_sha256", "title", "explanation_markdown",
  "checkpoints_json", "summary", "status", "created_at", "updated_at", "withdrawn_at"
)
SELECT
  "id", "owner_user_id", "qid", "source_generation_id", "source_override_version",
  "base_content_version", '', "title", "explanation_markdown",
  "checkpoints_json", "summary", "status", "created_at", "updated_at", "withdrawn_at"
FROM `question_change_proposals`;--> statement-breakpoint
DROP TABLE `question_change_proposals`;--> statement-breakpoint
ALTER TABLE `__new_question_change_proposals` RENAME TO `question_change_proposals`;--> statement-breakpoint
CREATE INDEX `question_change_proposals_owner_qid_created_idx` ON `question_change_proposals` (`owner_user_id`,`qid`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `question_change_proposals_owner_qid_active_unique` ON `question_change_proposals` (`owner_user_id`,`qid`) WHERE "question_change_proposals"."status" = 'submitted';--> statement-breakpoint
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
);--> statement-breakpoint
INSERT INTO `question_change_proposal_sources`
SELECT `owner_user_id`, `qid`, `source_generation_id`, `source_override_version`, `proposal_id`, `claimed_at`
FROM `__question_change_proposal_sources_backup`;--> statement-breakpoint
DROP TABLE `__question_change_proposal_sources_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `question_change_proposal_sources_proposal_unique` ON `question_change_proposal_sources` (`proposal_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `question_private_overrides` ADD `base_content_sha256` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `site_role_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_by` text,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "site_role_grants_role_check" CHECK("site_role_grants"."role" in ('reviewer', 'operator')),
	CONSTRAINT "site_role_grants_revocation_check" CHECK(("site_role_grants"."revoked_at" is null and "site_role_grants"."revoked_by" is null) or ("site_role_grants"."revoked_at" is not null and "site_role_grants"."revoked_by" is not null))
);--> statement-breakpoint
CREATE INDEX `site_role_grants_user_role_created_idx` ON `site_role_grants` (`user_id`,`role`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_role_grants_user_role_active_unique` ON `site_role_grants` (`user_id`,`role`) WHERE "site_role_grants"."revoked_at" is null;--> statement-breakpoint
CREATE TABLE `question_proposal_reviews` (
	`proposal_id` text PRIMARY KEY NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`source_generation_id` text NOT NULL,
	`source_override_version` integer NOT NULL,
	`base_content_version` text NOT NULL,
	`base_content_sha256` text NOT NULL,
	`decision` text NOT NULL,
	`comment` text NOT NULL,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `question_change_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_proposal_reviews_decision_check" CHECK("question_proposal_reviews"."decision" in ('approved', 'rejected'))
);--> statement-breakpoint
CREATE INDEX `question_proposal_reviews_reviewer_decided_idx` ON `question_proposal_reviews` (`reviewer_user_id`,`decided_at`);--> statement-breakpoint
CREATE TABLE `question_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`operator_user_id` text NOT NULL,
	`source_content_version` text NOT NULL,
	`target_content_version` text NOT NULL,
	`branch_name` text NOT NULL,
	`commit_sha` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`prepared_at` integer NOT NULL,
	`published_at` integer,
	`merge_commit_sha` text,
	FOREIGN KEY (`proposal_id`) REFERENCES `question_change_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operator_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_publications_status_check" CHECK("question_publications"."status" in ('prepared', 'published')),
	CONSTRAINT "question_publications_published_check" CHECK(("question_publications"."status" = 'prepared' and "question_publications"."published_at" is null and "question_publications"."merge_commit_sha" is null) or ("question_publications"."status" = 'published' and "question_publications"."published_at" is not null and "question_publications"."merge_commit_sha" is not null))
);--> statement-breakpoint
CREATE UNIQUE INDEX `question_publications_proposal_id_unique` ON `question_publications` (`proposal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `question_publications_commit_sha_unique` ON `question_publications` (`commit_sha`);--> statement-breakpoint
CREATE INDEX `question_publications_operator_prepared_idx` ON `question_publications` (`operator_user_id`,`prepared_at`);--> statement-breakpoint
CREATE TRIGGER `question_change_proposals_snapshot_immutable`
BEFORE UPDATE OF `owner_user_id`, `qid`, `source_generation_id`, `source_override_version`, `base_content_version`, `base_content_sha256`, `title`, `explanation_markdown`, `checkpoints_json`, `summary`, `created_at`
ON `question_change_proposals`
BEGIN
  SELECT RAISE(ABORT, 'question proposal snapshot is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `question_change_proposals_status_transition`
BEFORE UPDATE OF `status` ON `question_change_proposals`
WHEN NOT (
  (OLD.`status` = 'submitted' AND NEW.`status` IN ('withdrawn', 'approved', 'rejected'))
  OR (OLD.`status` = 'approved' AND NEW.`status` = 'published')
  OR OLD.`status` = NEW.`status`
)
BEGIN
  SELECT RAISE(ABORT, 'invalid question proposal status transition');
END;--> statement-breakpoint
CREATE TRIGGER `question_proposal_reviews_validate_insert`
BEFORE INSERT ON `question_proposal_reviews`
WHEN NOT EXISTS (
  SELECT 1 FROM `question_change_proposals` AS proposal
  WHERE proposal.`id` = NEW.`proposal_id`
    AND proposal.`owner_user_id` <> NEW.`reviewer_user_id`
    AND proposal.`source_generation_id` = NEW.`source_generation_id`
    AND proposal.`source_override_version` = NEW.`source_override_version`
    AND proposal.`base_content_version` = NEW.`base_content_version`
    AND proposal.`base_content_sha256` = NEW.`base_content_sha256`
    AND proposal.`status` = NEW.`decision`
)
BEGIN
  SELECT RAISE(ABORT, 'review does not match immutable proposal snapshot');
END;--> statement-breakpoint
CREATE TRIGGER `question_proposal_reviews_immutable_update`
BEFORE UPDATE ON `question_proposal_reviews`
BEGIN
  SELECT RAISE(ABORT, 'question proposal review is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `question_proposal_reviews_immutable_delete`
BEFORE DELETE ON `question_proposal_reviews`
BEGIN
  SELECT RAISE(ABORT, 'question proposal review is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `question_publications_validate_insert`
BEFORE INSERT ON `question_publications`
WHEN NOT EXISTS (
  SELECT 1 FROM `question_change_proposals` AS proposal
  WHERE proposal.`id` = NEW.`proposal_id` AND proposal.`status` = 'approved'
)
BEGIN
  SELECT RAISE(ABORT, 'only an approved proposal can be prepared for publication');
END;--> statement-breakpoint
CREATE TRIGGER `question_publications_prepared_immutable`
BEFORE UPDATE OF `proposal_id`, `operator_user_id`, `source_content_version`, `target_content_version`, `branch_name`, `commit_sha`, `prepared_at`
ON `question_publications`
BEGIN
  SELECT RAISE(ABORT, 'prepared publication audit is immutable');
END;
