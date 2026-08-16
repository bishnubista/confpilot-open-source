ALTER TABLE `review_corrections`
  ADD COLUMN `criterion_scores_staged` integer NOT NULL DEFAULT 0
  CHECK (`criterion_scores_staged` IN (0, 1));

CREATE TABLE IF NOT EXISTS `review_correction_criterion_score_staging` (
  `correction_id` text NOT NULL,
  `event_id` text NOT NULL,
  `review_id` text NOT NULL,
  `criterion_id` text NOT NULL,
  `score` integer NOT NULL,
  PRIMARY KEY (`correction_id`, `criterion_id`),
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`criterion_id`) REFERENCES `review_criteria` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (typeof(`score`) = 'integer')
);

DROP TRIGGER IF EXISTS `review_correction_score_staging_valid_insert`;
CREATE TRIGGER `review_correction_score_staging_valid_insert`
BEFORE INSERT ON `review_correction_criterion_score_staging`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `reviews` AS review
    INNER JOIN `review_criteria` AS criterion
      ON criterion.`plan_version_id` = review.`review_plan_version_id`
      AND criterion.`event_id` = review.`event_id`
      AND criterion.`id` = NEW.`criterion_id`
    WHERE review.`id` = NEW.`review_id`
      AND review.`event_id` = NEW.`event_id`
      AND NEW.`score` BETWEEN criterion.`minimum_score` AND criterion.`maximum_score`
  ) THEN RAISE(ABORT, 'staged correction criterion score must match its review plan and allowed range') END;
END;

DROP TRIGGER IF EXISTS `review_correction_score_staging_immutable_update`;
CREATE TRIGGER `review_correction_score_staging_immutable_update`
BEFORE UPDATE ON `review_correction_criterion_score_staging`
BEGIN
  SELECT RAISE(ABORT, 'staged correction criterion scores are immutable');
END;

DROP TRIGGER IF EXISTS `review_corrections_valid_insert`;
CREATE TRIGGER `review_corrections_valid_insert`
BEFORE INSERT ON `review_corrections`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM `reviews` AS review
    INNER JOIN `review_assignments` AS assignment
      ON assignment.`id` = review.`assignment_id` AND assignment.`event_id` = review.`event_id`
    INNER JOIN `proposals` AS proposal
      ON proposal.`id` = assignment.`proposal_id` AND proposal.`event_id` = assignment.`event_id`
    INNER JOIN `event_memberships` AS membership
      ON membership.`event_id` = assignment.`event_id`
      AND membership.`user_id` = assignment.`reviewer_user_id`
      AND membership.`role` = 'reviewer'
    WHERE review.`id` = NEW.`review_id`
      AND review.`event_id` = NEW.`event_id`
      AND assignment.`state` = 'assigned'
      AND assignment.`reviewer_user_id` = NEW.`corrected_by_user_id`
      AND NOT EXISTS (
        SELECT 1 FROM `reviewer_conflicts` AS conflict
        WHERE conflict.`assignment_id` = assignment.`id`
      )
      AND NOT EXISTS (
        SELECT 1
        FROM `proposal_presenters` AS presenter
        INNER JOIN `speakers` AS speaker
          ON speaker.`id` = presenter.`speaker_id` AND speaker.`event_id` = presenter.`event_id`
        WHERE presenter.`event_id` = assignment.`event_id`
          AND presenter.`proposal_id` = assignment.`proposal_id`
          AND speaker.`user_id` = assignment.`reviewer_user_id`
      )
      AND proposal.`owner_user_id` IS NOT assignment.`reviewer_user_id`
      AND COALESCE((
        SELECT action.`action` FROM `review_assignment_actions` AS action
        WHERE action.`assignment_id` = assignment.`id`
        ORDER BY action.`sequence` DESC LIMIT 1
      ), CASE WHEN assignment.`requires_response` = 1 THEN 'pending' ELSE 'accepted' END) = 'accepted'
      AND (
        (assignment.`review_round_id` IS NULL AND proposal.`status` IN ('submitted', 'in_review'))
        OR EXISTS (
          SELECT 1 FROM `review_rounds` AS round
          WHERE round.`id` = assignment.`review_round_id`
            AND round.`event_id` = assignment.`event_id`
            AND round.`opens_at` <= NEW.`corrected_at`
            AND round.`closes_at` > NEW.`corrected_at`
        )
      )
  ) THEN RAISE(ABORT, 'review correction requires its assigned reviewer in an open event round') END;
  SELECT CASE WHEN NEW.`revision_number` != COALESCE((
    SELECT MAX(correction.`revision_number`) + 1
    FROM `review_corrections` AS correction
    WHERE correction.`review_id` = NEW.`review_id`
  ), 2) THEN RAISE(ABORT, 'review correction revision must be the next sequence') END;
  SELECT CASE WHEN NEW.`review_plan_version_id` IS NOT (
    SELECT review.`review_plan_version_id` FROM `reviews` AS review WHERE review.`id` = NEW.`review_id`
  ) OR (NEW.`review_plan_version_id` IS NULL) IS NOT (NEW.`weighted_score_milli` IS NULL)
  THEN RAISE(ABORT, 'review correction must preserve its review plan version and weighted score') END;
  SELECT CASE WHEN NEW.`criterion_scores_staged` = 1 AND NEW.`review_plan_version_id` IS NULL THEN
    RAISE(ABORT, 'legacy review correction cannot require staged criterion scores') END;
  SELECT CASE WHEN NEW.`review_plan_version_id` IS NULL AND EXISTS (
    SELECT 1 FROM `review_correction_criterion_score_staging` AS staged
    WHERE staged.`correction_id` = NEW.`id`
  ) THEN RAISE(ABORT, 'legacy review correction cannot include criterion scores') END;
  SELECT CASE WHEN NEW.`criterion_scores_staged` = 1 AND NEW.`review_plan_version_id` IS NOT NULL AND (
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

DROP TRIGGER IF EXISTS `review_corrections_promote_staged_scores_insert`;
CREATE TRIGGER `review_corrections_promote_staged_scores_insert`
AFTER INSERT ON `review_corrections`
BEGIN
  INSERT INTO `review_correction_criterion_scores` (`correction_id`, `event_id`, `criterion_id`, `score`)
  SELECT NEW.`id`, staged.`event_id`, staged.`criterion_id`, staged.`score`
  FROM `review_correction_criterion_score_staging` AS staged
  WHERE staged.`correction_id` = NEW.`id`
    AND staged.`event_id` = NEW.`event_id`
    AND staged.`review_id` = NEW.`review_id`;

  DELETE FROM `review_correction_criterion_score_staging`
  WHERE `correction_id` = NEW.`id`;
END;
