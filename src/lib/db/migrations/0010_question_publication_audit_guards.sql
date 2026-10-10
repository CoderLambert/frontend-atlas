CREATE TRIGGER `site_role_grants_origin_immutable`
BEFORE UPDATE OF `user_id`, `role`, `created_by`, `created_at`
ON `site_role_grants`
BEGIN
  SELECT RAISE(ABORT, 'site role grant origin is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `site_role_grants_audit_delete_guard`
BEFORE DELETE ON `site_role_grants`
BEGIN
  SELECT RAISE(ABORT, 'site role grant audit cannot be deleted');
END;--> statement-breakpoint
CREATE TRIGGER `question_change_proposals_audit_delete_guard`
BEFORE DELETE ON `question_change_proposals`
BEGIN
  SELECT RAISE(ABORT, 'question proposal audit cannot be deleted');
END;--> statement-breakpoint
CREATE TRIGGER `question_publications_status_transition`
BEFORE UPDATE OF `status`, `published_at`, `merge_commit_sha`
ON `question_publications`
WHEN NOT (
  (
    OLD.`status` = 'prepared'
    AND NEW.`status` = 'published'
    AND OLD.`published_at` IS NULL
    AND OLD.`merge_commit_sha` IS NULL
    AND NEW.`published_at` IS NOT NULL
    AND NEW.`merge_commit_sha` IS NOT NULL
  )
  OR (
    OLD.`status` = NEW.`status`
    AND OLD.`published_at` IS NEW.`published_at`
    AND OLD.`merge_commit_sha` IS NEW.`merge_commit_sha`
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid question publication status transition');
END;--> statement-breakpoint
CREATE TRIGGER `question_publications_audit_delete_guard`
BEFORE DELETE ON `question_publications`
BEGIN
  SELECT RAISE(ABORT, 'question publication audit cannot be deleted');
END;
