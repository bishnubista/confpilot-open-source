CREATE TABLE `review_rounds` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `name` text NOT NULL,
  `opens_at` text NOT NULL,
  `closes_at` text NOT NULL,
  `blind_default` integer DEFAULT 1 NOT NULL,
  `position` integer NOT NULL,
  `created_by_user_id` text NOT NULL,
  `updated_by_user_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (length(trim(`name`)) BETWEEN 1 AND 120),
  CHECK (`opens_at` < `closes_at`),
  CHECK (`blind_default` IN (0, 1)),
  CHECK (typeof(`position`) = 'integer' AND `position` >= 0)
);
CREATE UNIQUE INDEX `review_rounds_event_position_unique`
  ON `review_rounds` (`event_id`, `position`);
CREATE INDEX `review_rounds_event_index` ON `review_rounds` (`event_id`, `opens_at`);

CREATE TRIGGER `review_rounds_valid_insert`
BEFORE INSERT ON `review_rounds`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'review round requires an event organizer') END;
  SELECT CASE WHEN NEW.`updated_by_user_id` IS NOT NULL OR NEW.`created_at` != NEW.`updated_at`
  THEN RAISE(ABORT, 'review round must start unmodified') END;
END;

CREATE TRIGGER `review_rounds_identity_immutable_update`
BEFORE UPDATE OF `id`, `event_id`, `created_by_user_id`, `created_at` ON `review_rounds`
BEGIN
  SELECT RAISE(ABORT, 'review round identity is immutable');
END;

CREATE TRIGGER `review_rounds_valid_update`
BEFORE UPDATE ON `review_rounds`
WHEN NEW.`name` IS NOT OLD.`name`
  OR NEW.`opens_at` IS NOT OLD.`opens_at`
  OR NEW.`closes_at` IS NOT OLD.`closes_at`
  OR NEW.`blind_default` IS NOT OLD.`blind_default`
  OR NEW.`position` IS NOT OLD.`position`
  OR NEW.`updated_at` IS NOT OLD.`updated_at`
  OR NEW.`updated_by_user_id` IS NOT OLD.`updated_by_user_id`
BEGIN
  SELECT CASE WHEN NEW.`updated_by_user_id` IS NULL OR NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = OLD.`event_id` AND `user_id` = NEW.`updated_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'review round update requires an event organizer') END;
END;

CREATE TRIGGER `review_rounds_referenced_delete`
BEFORE DELETE ON `review_rounds`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `review_plans` WHERE `review_round_id` = OLD.`id`
  ) OR EXISTS (
    SELECT 1 FROM `review_assignments` WHERE `review_round_id` = OLD.`id`
  ) THEN RAISE(ABORT, 'review round with plans or assignments cannot be deleted') END;
END;

CREATE TABLE `review_round_reviewers` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `review_round_id` text NOT NULL,
  `reviewer_user_id` text NOT NULL,
  `added_by_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`review_round_id`) REFERENCES `review_rounds` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`reviewer_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`added_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `review_round_reviewers_round_reviewer_unique`
  ON `review_round_reviewers` (`review_round_id`, `reviewer_user_id`);
CREATE INDEX `review_round_reviewers_event_reviewer_index`
  ON `review_round_reviewers` (`event_id`, `reviewer_user_id`);

CREATE TRIGGER `review_round_reviewers_valid_insert`
BEFORE INSERT ON `review_round_reviewers`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `review_rounds`
    WHERE `id` = NEW.`review_round_id` AND `event_id` = NEW.`event_id`
  ) THEN RAISE(ABORT, 'review round pool entry must belong to a same-event round') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`reviewer_user_id` AND `role` = 'reviewer'
  ) THEN RAISE(ABORT, 'review round pool entry requires an event reviewer') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`added_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'review round pool entry requires an event organizer') END;
END;

CREATE TRIGGER `review_round_reviewers_immutable_update`
BEFORE UPDATE ON `review_round_reviewers`
BEGIN
  SELECT RAISE(ABORT, 'review round pool entries are immutable');
END;

CREATE TRIGGER `review_round_reviewers_assigned_delete`
BEFORE DELETE ON `review_round_reviewers`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `review_assignments`
    WHERE `review_round_id` = OLD.`review_round_id`
      AND `reviewer_user_id` = OLD.`reviewer_user_id`
      AND `state` = 'assigned'
  ) THEN RAISE(ABORT, 'review round pool entry with active assignments cannot be removed') END;
END;

ALTER TABLE `review_plans` ADD COLUMN `review_round_id` text
  REFERENCES `review_rounds` (`id`) ON UPDATE no action ON DELETE restrict;

DROP INDEX `review_plans_event_unique`;
CREATE UNIQUE INDEX `review_plans_event_default_unique`
  ON `review_plans` (`event_id`) WHERE `review_round_id` IS NULL;
CREATE UNIQUE INDEX `review_plans_event_round_unique`
  ON `review_plans` (`event_id`, `review_round_id`) WHERE `review_round_id` IS NOT NULL;

DROP TRIGGER `review_plans_identity_immutable_update`;
CREATE TRIGGER `review_plans_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `name`, `created_by_user_id`, `created_at`, `review_round_id`
ON `review_plans`
BEGIN
  SELECT RAISE(ABORT, 'review plan identity is immutable');
END;

DROP TRIGGER `review_plans_valid_insert`;
CREATE TRIGGER `review_plans_valid_insert`
BEFORE INSERT ON `review_plans`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'review plan requires an event organizer') END;
  SELECT CASE WHEN NEW.`review_round_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `review_rounds`
    WHERE `id` = NEW.`review_round_id` AND `event_id` = NEW.`event_id`
  ) THEN RAISE(ABORT, 'review plan round must belong to the same event') END;
END;

ALTER TABLE `review_plan_versions` ADD COLUMN `builtin_labels_json` text;

CREATE TRIGGER `review_plan_versions_builtin_labels_valid_insert`
BEFORE INSERT ON `review_plan_versions`
WHEN NEW.`builtin_labels_json` IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.`builtin_labels_json`)
    OR json_type(NEW.`builtin_labels_json`) != 'object'
    OR (SELECT COUNT(*) FROM json_each(NEW.`builtin_labels_json`)) != 4
    OR json_type(NEW.`builtin_labels_json`, '$.recommendationAccept') != 'text'
    OR json_type(NEW.`builtin_labels_json`, '$.recommendationDiscuss') != 'text'
    OR json_type(NEW.`builtin_labels_json`, '$.recommendationReject') != 'text'
    OR json_type(NEW.`builtin_labels_json`, '$.commentsLabel') != 'text'
    OR length(trim(json_extract(NEW.`builtin_labels_json`, '$.recommendationAccept'))) NOT BETWEEN 1 AND 40
    OR length(trim(json_extract(NEW.`builtin_labels_json`, '$.recommendationDiscuss'))) NOT BETWEEN 1 AND 40
    OR length(trim(json_extract(NEW.`builtin_labels_json`, '$.recommendationReject'))) NOT BETWEEN 1 AND 40
    OR length(trim(json_extract(NEW.`builtin_labels_json`, '$.commentsLabel'))) NOT BETWEEN 1 AND 40
  THEN RAISE(ABORT, 'review plan builtin labels must name the three recommendations and the comments field') END;
END;

ALTER TABLE `review_assignments` ADD COLUMN `review_round_id` text
  REFERENCES `review_rounds` (`id`) ON UPDATE no action ON DELETE restrict;

DROP INDEX `review_assignments_one_active_unique`;
CREATE UNIQUE INDEX `review_assignments_one_active_default_unique`
  ON `review_assignments` (`event_id`, `proposal_id`, `reviewer_user_id`)
  WHERE `state` = 'assigned' AND `review_round_id` IS NULL;
CREATE UNIQUE INDEX `review_assignments_one_active_review_round_unique`
  ON `review_assignments` (`event_id`, `proposal_id`, `reviewer_user_id`, `review_round_id`)
  WHERE `state` = 'assigned' AND `review_round_id` IS NOT NULL;

DROP TRIGGER `review_assignments_identity_immutable_update`;
CREATE TRIGGER `review_assignments_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `proposal_id`, `reviewer_user_id`, `created_by_user_id`,
  `round`, `blind`, `created_at`, `review_plan_version_id`, `requires_response`, `review_round_id`
ON `review_assignments`
BEGIN
  SELECT RAISE(ABORT, 'review assignment identity is immutable');
END;

DROP TRIGGER `review_assignments_scope_insert`;
CREATE TRIGGER `review_assignments_scope_insert`
BEFORE INSERT ON `review_assignments`
BEGIN
  SELECT CASE WHEN NEW.`state` IS NOT 'assigned'
  THEN RAISE(ABORT, 'review assignment must start assigned') END;
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) IS NOT NEW.`event_id`
    OR COALESCE(
      (SELECT `status` FROM `proposals` WHERE `id` = NEW.`proposal_id`),
      'missing'
    ) NOT IN ('submitted', 'in_review')
  THEN RAISE(ABORT, 'review assignment proposal must be reviewable in the same event') END;
  SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`reviewer_user_id`
        AND `role` = 'reviewer'
    )
  THEN RAISE(ABORT, 'review assignment requires an event reviewer') END;
  SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`created_by_user_id`
        AND `role` = 'organizer'
    )
  THEN RAISE(ABORT, 'review assignment requires an event organizer') END;
  SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM `proposals` AS proposal
      LEFT JOIN `proposal_presenters` AS presenter
        ON presenter.`event_id` = proposal.`event_id`
        AND presenter.`proposal_id` = proposal.`id`
      LEFT JOIN `speakers` AS speaker
        ON speaker.`event_id` = presenter.`event_id`
        AND speaker.`id` = presenter.`speaker_id`
      WHERE proposal.`id` = NEW.`proposal_id`
        AND proposal.`event_id` = NEW.`event_id`
        AND (
          proposal.`owner_user_id` IS NEW.`reviewer_user_id`
          OR speaker.`user_id` IS NEW.`reviewer_user_id`
        )
    )
  THEN RAISE(ABORT, 'review assignment cannot be self-review') END;
  SELECT CASE WHEN NEW.`review_round_id` IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM `review_rounds`
      WHERE `id` = NEW.`review_round_id` AND `event_id` = NEW.`event_id`
    )
  THEN RAISE(ABORT, 'review assignment round must belong to the same event') END;
  SELECT CASE WHEN NEW.`review_round_id` IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM `review_round_reviewers`
      WHERE `review_round_id` = NEW.`review_round_id`
        AND `reviewer_user_id` = NEW.`reviewer_user_id`
    )
  THEN RAISE(ABORT, 'review assignment reviewer must belong to the round pool') END;
END;

DROP TRIGGER `review_assignments_plan_version_insert`;
CREATE TRIGGER `review_assignments_plan_version_insert`
BEFORE INSERT ON `review_assignments`
BEGIN
  SELECT CASE WHEN NEW.`review_plan_version_id` IS NOT (
    SELECT `active_version_id` FROM `review_plans`
    WHERE `event_id` = NEW.`event_id` AND `review_round_id` IS NEW.`review_round_id`
  ) THEN RAISE(ABORT, 'review assignment must pin the active plan version for its round') END;
END;

DROP TRIGGER `message_outbox_actor_valid_insert`;
CREATE TRIGGER `message_outbox_actor_valid_insert`
BEFORE INSERT ON `message_outbox`
WHEN
  (NEW.`intent` IN ('speaker_reminder', 'reviewer_reminder') AND NEW.`actor_user_id` IS NULL)
  OR (
    NEW.`actor_user_id` IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`actor_user_id`
        AND `role` = 'organizer'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'message actor must be a same-event organizer');
END;
