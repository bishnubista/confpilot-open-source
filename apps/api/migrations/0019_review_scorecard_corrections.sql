CREATE TABLE IF NOT EXISTS `review_corrections` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `review_id` text NOT NULL,
  `revision_number` integer NOT NULL,
  `corrected_by_user_id` text NOT NULL,
  `originality_score` integer NOT NULL,
  `relevance_score` integer NOT NULL,
  `recommendation` text NOT NULL,
  `comment` text NOT NULL,
  `review_plan_version_id` text,
  `weighted_score_milli` integer,
  `corrected_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`corrected_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`review_plan_version_id`) REFERENCES `review_plan_versions` (`id`) ON UPDATE no action ON DELETE restrict,
  UNIQUE (`review_id`, `revision_number`),
  CHECK (typeof(`revision_number`) = 'integer' AND `revision_number` >= 2),
  CHECK (typeof(`originality_score`) = 'integer' AND `originality_score` BETWEEN 1 AND 5),
  CHECK (typeof(`relevance_score`) = 'integer' AND `relevance_score` BETWEEN 1 AND 5),
  CHECK (`recommendation` IN ('accept', 'discuss', 'reject')),
  CHECK (length(trim(`comment`)) BETWEEN 1 AND 4000),
  CHECK (`weighted_score_milli` IS NULL OR
    (typeof(`weighted_score_milli`) = 'integer' AND `weighted_score_milli` BETWEEN 1000 AND 5000))
);
CREATE INDEX IF NOT EXISTS `review_corrections_event_review_index`
  ON `review_corrections` (`event_id`, `review_id`, `revision_number` DESC);

CREATE TABLE IF NOT EXISTS `review_correction_criterion_scores` (
  `correction_id` text NOT NULL,
  `event_id` text NOT NULL,
  `criterion_id` text NOT NULL,
  `score` integer NOT NULL,
  PRIMARY KEY (`correction_id`, `criterion_id`),
  FOREIGN KEY (`correction_id`) REFERENCES `review_corrections` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`criterion_id`) REFERENCES `review_criteria` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (typeof(`score`) = 'integer')
);

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
END;

DROP TRIGGER IF EXISTS `review_corrections_immutable_update`;
CREATE TRIGGER `review_corrections_immutable_update`
BEFORE UPDATE ON `review_corrections`
BEGIN
  SELECT RAISE(ABORT, 'review corrections are immutable');
END;

DROP TRIGGER IF EXISTS `review_corrections_immutable_delete`;
CREATE TRIGGER `review_corrections_immutable_delete`
BEFORE DELETE ON `review_corrections`
BEGIN
  SELECT RAISE(ABORT, 'review corrections are immutable');
END;

DROP TRIGGER IF EXISTS `review_correction_criterion_scores_valid_insert`;
CREATE TRIGGER `review_correction_criterion_scores_valid_insert`
BEFORE INSERT ON `review_correction_criterion_scores`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `review_corrections` AS correction
    INNER JOIN `review_criteria` AS criterion
      ON criterion.`plan_version_id` = correction.`review_plan_version_id`
      AND criterion.`id` = NEW.`criterion_id`
      AND criterion.`event_id` = correction.`event_id`
    WHERE correction.`id` = NEW.`correction_id`
      AND correction.`event_id` = NEW.`event_id`
      AND NEW.`score` BETWEEN criterion.`minimum_score` AND criterion.`maximum_score`
  ) THEN RAISE(ABORT, 'correction criterion score must match its review plan and allowed range') END;
END;

DROP TRIGGER IF EXISTS `review_correction_criterion_scores_immutable_update`;
CREATE TRIGGER `review_correction_criterion_scores_immutable_update`
BEFORE UPDATE ON `review_correction_criterion_scores`
BEGIN
  SELECT RAISE(ABORT, 'submitted correction criterion scores are immutable');
END;

DROP TRIGGER IF EXISTS `review_correction_criterion_scores_immutable_delete`;
CREATE TRIGGER `review_correction_criterion_scores_immutable_delete`
BEFORE DELETE ON `review_correction_criterion_scores`
BEGIN
  SELECT RAISE(ABORT, 'submitted correction criterion scores are immutable');
END;

DROP VIEW IF EXISTS `current_review_criterion_scores`;
DROP VIEW IF EXISTS `current_reviews`;

CREATE VIEW `current_reviews` AS
SELECT
  COALESCE(correction.`id`, review.`id`) AS `id`,
  review.`id` AS `base_review_id`,
  review.`event_id`,
  review.`assignment_id`,
  COALESCE(correction.`originality_score`, review.`originality_score`) AS `originality_score`,
  COALESCE(correction.`relevance_score`, review.`relevance_score`) AS `relevance_score`,
  COALESCE(correction.`recommendation`, review.`recommendation`) AS `recommendation`,
  COALESCE(correction.`comment`, review.`comment`) AS `comment`,
  review.`submitted_at`,
  correction.`corrected_at`,
  COALESCE(correction.`revision_number`, 1) AS `revision_number`,
  COALESCE(correction.`review_plan_version_id`, review.`review_plan_version_id`) AS `review_plan_version_id`,
  COALESCE(correction.`weighted_score_milli`, review.`weighted_score_milli`) AS `weighted_score_milli`
FROM `reviews` AS review
LEFT JOIN `review_corrections` AS correction
  ON correction.`review_id` = review.`id`
  AND correction.`revision_number` = (
    SELECT MAX(latest.`revision_number`)
    FROM `review_corrections` AS latest
    WHERE latest.`review_id` = review.`id`
  );

CREATE VIEW `current_review_criterion_scores` AS
SELECT
  current.`id` AS `review_id`,
  score.`event_id`,
  score.`criterion_id`,
  score.`score`
FROM `current_reviews` AS current
INNER JOIN `review_criterion_scores` AS score ON score.`review_id` = current.`base_review_id`
WHERE current.`revision_number` = 1
UNION ALL
SELECT
  current.`id` AS `review_id`,
  score.`event_id`,
  score.`criterion_id`,
  score.`score`
FROM `current_reviews` AS current
INNER JOIN `review_correction_criterion_scores` AS score ON score.`correction_id` = current.`id`
WHERE current.`revision_number` > 1;
