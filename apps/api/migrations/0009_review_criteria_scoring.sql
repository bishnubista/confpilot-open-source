CREATE TABLE `review_plans` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `name` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `activated_by_user_id` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`activated_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (length(trim(`name`)) BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX `review_plans_event_unique` ON `review_plans` (`event_id`);

CREATE TABLE `review_plan_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `plan_id` text NOT NULL,
  `version_number` integer NOT NULL,
  `name` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`plan_id`) REFERENCES `review_plans` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (typeof(`version_number`) = 'integer' AND `version_number` > 0),
  CHECK (length(trim(`name`)) BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX `review_plan_versions_plan_number_unique`
  ON `review_plan_versions` (`plan_id`, `version_number`);

CREATE TABLE `review_criteria` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `plan_version_id` text NOT NULL,
  `criterion_key` text NOT NULL,
  `label` text NOT NULL,
  `description` text NOT NULL,
  `weight_basis_points` integer NOT NULL,
  `minimum_score` integer DEFAULT 1 NOT NULL,
  `maximum_score` integer DEFAULT 5 NOT NULL,
  `sort_order` integer NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`plan_version_id`) REFERENCES `review_plan_versions` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`criterion_key` GLOB '[a-z]*' AND `criterion_key` NOT GLOB '*[^a-z0-9_-]*'
    AND length(`criterion_key`) BETWEEN 1 AND 64),
  CHECK (length(trim(`label`)) BETWEEN 1 AND 120),
  CHECK (length(`description`) <= 1000),
  CHECK (typeof(`weight_basis_points`) = 'integer' AND `weight_basis_points` BETWEEN 1 AND 10000),
  CHECK (typeof(`minimum_score`) = 'integer' AND typeof(`maximum_score`) = 'integer'
    AND `minimum_score` >= 1 AND `maximum_score` <= 10 AND `minimum_score` < `maximum_score`),
  CHECK (typeof(`sort_order`) = 'integer' AND `sort_order` >= 0)
);
CREATE UNIQUE INDEX `review_criteria_version_key_unique`
  ON `review_criteria` (`plan_version_id`, `criterion_key`);
CREATE UNIQUE INDEX `review_criteria_version_order_unique`
  ON `review_criteria` (`plan_version_id`, `sort_order`);

ALTER TABLE `review_plans` ADD COLUMN `active_version_id` text
  REFERENCES `review_plan_versions` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `review_assignments` ADD COLUMN `review_plan_version_id` text
  REFERENCES `review_plan_versions` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `reviews` ADD COLUMN `review_plan_version_id` text
  REFERENCES `review_plan_versions` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `reviews` ADD COLUMN `weighted_score_milli` integer
  CHECK (`weighted_score_milli` IS NULL OR
    (typeof(`weighted_score_milli`) = 'integer' AND `weighted_score_milli` BETWEEN 1000 AND 5000));

CREATE TABLE `review_criterion_scores` (
  `review_id` text NOT NULL,
  `event_id` text NOT NULL,
  `criterion_id` text NOT NULL,
  `score` integer NOT NULL,
  PRIMARY KEY (`review_id`, `criterion_id`),
  FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`criterion_id`) REFERENCES `review_criteria` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (typeof(`score`) = 'integer')
);
CREATE INDEX `review_criterion_scores_event_criterion_index`
  ON `review_criterion_scores` (`event_id`, `criterion_id`);

CREATE TRIGGER `review_plans_valid_insert`
BEFORE INSERT ON `review_plans`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'review plan requires an event organizer') END;
END;

CREATE TRIGGER `review_plans_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `name`, `created_by_user_id`, `created_at` ON `review_plans`
BEGIN
  SELECT RAISE(ABORT, 'review plan identity is immutable');
END;

CREATE TRIGGER `review_plans_immutable_delete`
BEFORE DELETE ON `review_plans`
BEGIN
  SELECT RAISE(ABORT, 'review plans are immutable');
END;

CREATE TRIGGER `review_plan_versions_valid_insert`
BEFORE INSERT ON `review_plan_versions`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `review_plans`
    WHERE `id` = NEW.`plan_id` AND `event_id` = NEW.`event_id`
  ) OR NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'review plan version must be organizer-owned in one event') END;
END;

CREATE TRIGGER `review_plan_versions_immutable_update`
BEFORE UPDATE ON `review_plan_versions`
BEGIN
  SELECT RAISE(ABORT, 'review plan versions are immutable');
END;
CREATE TRIGGER `review_plan_versions_immutable_delete`
BEFORE DELETE ON `review_plan_versions`
BEGIN
  SELECT RAISE(ABORT, 'review plan versions are immutable');
END;
CREATE TRIGGER `review_criteria_immutable_update`
BEFORE UPDATE ON `review_criteria`
BEGIN
  SELECT RAISE(ABORT, 'review criteria are immutable');
END;
CREATE TRIGGER `review_criteria_immutable_delete`
BEFORE DELETE ON `review_criteria`
BEGIN
  SELECT RAISE(ABORT, 'review criteria are immutable');
END;

CREATE TRIGGER `review_criteria_valid_insert`
BEFORE INSERT ON `review_criteria`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `review_plan_versions`
    WHERE `id` = NEW.`plan_version_id` AND `event_id` = NEW.`event_id`
  ) OR EXISTS (
    SELECT 1 FROM `review_plans` WHERE `active_version_id` = NEW.`plan_version_id`
  ) OR EXISTS (
    SELECT 1 FROM `review_assignments` WHERE `review_plan_version_id` = NEW.`plan_version_id`
  ) OR EXISTS (
    SELECT 1
    FROM `review_plan_versions` AS candidate
    INNER JOIN `review_plan_versions` AS newer
      ON newer.`plan_id` = candidate.`plan_id`
      AND newer.`event_id` = candidate.`event_id`
      AND newer.`version_number` > candidate.`version_number`
    WHERE candidate.`id` = NEW.`plan_version_id`
      AND candidate.`event_id` = NEW.`event_id`
  ) THEN RAISE(ABORT, 'review criterion must belong to an unused inactive event plan version') END;
END;

CREATE TRIGGER `review_plans_activate_valid_version`
BEFORE UPDATE OF `active_version_id`, `activated_by_user_id` ON `review_plans`
WHEN NEW.`active_version_id` IS NOT OLD.`active_version_id`
  OR NEW.`activated_by_user_id` IS NOT OLD.`activated_by_user_id`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `review_plan_versions`
    WHERE `id` = NEW.`active_version_id` AND `plan_id` = OLD.`id` AND `event_id` = OLD.`event_id`
  ) OR NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = OLD.`event_id` AND `user_id` = NEW.`activated_by_user_id` AND `role` = 'organizer'
  ) OR (SELECT COUNT(*) FROM `review_criteria` WHERE `plan_version_id` = NEW.`active_version_id`) = 0
    OR (SELECT SUM(`weight_basis_points`) FROM `review_criteria`
      WHERE `plan_version_id` = NEW.`active_version_id`) != 10000
  THEN RAISE(ABORT, 'active review plan version requires criteria totaling 10000 basis points') END;
END;

DROP TRIGGER `review_assignments_identity_immutable_update`;
CREATE TRIGGER `review_assignments_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `proposal_id`, `reviewer_user_id`, `created_by_user_id`,
  `round`, `blind`, `created_at`, `review_plan_version_id`
ON `review_assignments`
BEGIN
  SELECT RAISE(ABORT, 'review assignment identity is immutable');
END;

CREATE TRIGGER `review_assignments_plan_version_insert`
BEFORE INSERT ON `review_assignments`
BEGIN
  SELECT CASE WHEN NEW.`review_plan_version_id` IS NOT (
    SELECT `active_version_id` FROM `review_plans` WHERE `event_id` = NEW.`event_id`
  ) THEN RAISE(ABORT, 'review assignment must pin the active event plan version') END;
END;

CREATE TRIGGER `reviews_plan_version_insert`
BEFORE INSERT ON `reviews`
BEGIN
  SELECT CASE WHEN NEW.`review_plan_version_id` IS NOT (
    SELECT `review_plan_version_id` FROM `review_assignments` WHERE `id` = NEW.`assignment_id`
  ) OR (NEW.`review_plan_version_id` IS NULL) IS NOT (NEW.`weighted_score_milli` IS NULL)
  THEN RAISE(ABORT, 'review must pin its assignment plan version and weighted score') END;
END;

CREATE TRIGGER `review_criterion_scores_valid_insert`
BEFORE INSERT ON `review_criterion_scores`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `reviews` review
    INNER JOIN `review_criteria` criterion
      ON criterion.`plan_version_id` = review.`review_plan_version_id`
      AND criterion.`id` = NEW.`criterion_id`
      AND criterion.`event_id` = review.`event_id`
    WHERE review.`id` = NEW.`review_id` AND review.`event_id` = NEW.`event_id`
      AND NEW.`score` BETWEEN criterion.`minimum_score` AND criterion.`maximum_score`
  ) THEN RAISE(ABORT, 'criterion score must match its review plan and allowed range') END;
END;
CREATE TRIGGER `review_criterion_scores_immutable_update`
BEFORE UPDATE ON `review_criterion_scores`
BEGIN
  SELECT RAISE(ABORT, 'submitted criterion scores are immutable');
END;
CREATE TRIGGER `review_criterion_scores_immutable_delete`
BEFORE DELETE ON `review_criterion_scores`
BEGIN
  SELECT RAISE(ABORT, 'submitted criterion scores are immutable');
END;
