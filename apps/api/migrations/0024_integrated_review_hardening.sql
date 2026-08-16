CREATE UNIQUE INDEX `reviewer_invitations_outbox_message_unique`
  ON `reviewer_invitations` (`outbox_message_id`);

CREATE TRIGGER `review_rounds_canonical_window_insert`
BEFORE INSERT ON `review_rounds`
WHEN NEW.`opens_at` IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`opens_at`)
  OR NEW.`closes_at` IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`closes_at`)
BEGIN
  SELECT RAISE(ABORT, 'review round window must use canonical UTC-second timestamps');
END;

CREATE TRIGGER `review_rounds_canonical_window_update`
BEFORE UPDATE OF `opens_at`, `closes_at` ON `review_rounds`
WHEN NEW.`opens_at` IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`opens_at`)
  OR NEW.`closes_at` IS NOT strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`closes_at`)
BEGIN
  SELECT RAISE(ABORT, 'review round window must use canonical UTC-second timestamps');
END;

CREATE TRIGGER `review_corrections_complete_scores_insert`
BEFORE INSERT ON `review_corrections`
WHEN NEW.`review_plan_version_id` IS NOT NULL
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM `review_correction_criterion_score_staging` AS staged
    WHERE staged.`correction_id` = NEW.`id`
      AND staged.`event_id` = NEW.`event_id`
      AND staged.`review_id` = NEW.`review_id`
  ) != (
    SELECT COUNT(*) FROM `review_criteria` AS criterion
    WHERE criterion.`event_id` = NEW.`event_id`
      AND criterion.`plan_version_id` = NEW.`review_plan_version_id`
  ) THEN RAISE(ABORT, 'review correction requires exactly one criterion score for every plan criterion') END;
END;
