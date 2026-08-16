CREATE TABLE `review_assignments` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `proposal_id` text NOT NULL,
  `reviewer_user_id` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `round` integer DEFAULT 1 NOT NULL,
  `blind` integer DEFAULT 1 NOT NULL,
  `state` text DEFAULT 'assigned' NOT NULL,
  `due_at` text,
  `revoked_at` text,
  `revoked_by_user_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`proposal_id`) REFERENCES `proposals` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`reviewer_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`round` > 0),
  CHECK (`blind` IN (0, 1)),
  CHECK (`state` IN ('assigned', 'revoked')),
  CHECK (
    (`state` = 'assigned' AND `revoked_at` IS NULL AND `revoked_by_user_id` IS NULL)
    OR (`state` = 'revoked' AND `revoked_at` IS NOT NULL AND `revoked_by_user_id` IS NOT NULL)
  )
);
CREATE UNIQUE INDEX `review_assignments_event_proposal_reviewer_round_unique`
  ON `review_assignments` (`event_id`, `proposal_id`, `reviewer_user_id`, `round`);
CREATE UNIQUE INDEX `review_assignments_one_active_unique`
  ON `review_assignments` (`event_id`, `proposal_id`, `reviewer_user_id`)
  WHERE `state` = 'assigned';
CREATE INDEX `review_assignments_event_reviewer_state_queue_index`
  ON `review_assignments` (`event_id`, `reviewer_user_id`, `state`);

CREATE TABLE `reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `assignment_id` text NOT NULL,
  `originality_score` integer NOT NULL,
  `relevance_score` integer NOT NULL,
  `recommendation` text NOT NULL,
  `comment` text NOT NULL,
  `submitted_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`assignment_id`) REFERENCES `review_assignments` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (typeof(`originality_score`) = 'integer' AND `originality_score` BETWEEN 1 AND 5),
  CHECK (typeof(`relevance_score`) = 'integer' AND `relevance_score` BETWEEN 1 AND 5),
  CHECK (`recommendation` IN ('accept', 'discuss', 'reject')),
  CHECK (length(trim(`comment`)) BETWEEN 1 AND 4000)
);
CREATE UNIQUE INDEX `reviews_assignment_unique` ON `reviews` (`assignment_id`);

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
END;

CREATE TRIGGER `review_assignments_identity_immutable_update`
BEFORE UPDATE OF
  `event_id`, `proposal_id`, `reviewer_user_id`, `created_by_user_id`,
  `round`, `blind`, `created_at`
ON `review_assignments`
BEGIN
  SELECT RAISE(ABORT, 'review assignment identity is immutable');
END;

CREATE TRIGGER `review_assignments_state_update`
BEFORE UPDATE OF `state`, `revoked_at`, `revoked_by_user_id` ON `review_assignments`
WHEN NEW.`state` IS NOT OLD.`state`
  OR NEW.`revoked_at` IS NOT OLD.`revoked_at`
  OR NEW.`revoked_by_user_id` IS NOT OLD.`revoked_by_user_id`
BEGIN
  SELECT CASE WHEN
    OLD.`state` = 'revoked'
    OR NEW.`state` != 'revoked'
    OR NEW.`revoked_at` IS NULL
    OR NEW.`revoked_by_user_id` IS NULL
    OR EXISTS (
      SELECT 1 FROM `reviews` WHERE `assignment_id` = OLD.`id`
    )
    OR NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = OLD.`event_id`
        AND `user_id` = NEW.`revoked_by_user_id`
        AND `role` = 'organizer'
    )
  THEN RAISE(ABORT, 'a completed or revoked review assignment cannot change state') END;
END;

CREATE TRIGGER `review_assignments_immutable_delete`
BEFORE DELETE ON `review_assignments`
BEGIN
  SELECT RAISE(ABORT, 'review assignments use soft revocation and cannot be deleted');
END;

CREATE TRIGGER `review_assignments_revoked_frozen_update`
BEFORE UPDATE OF `due_at`, `updated_at` ON `review_assignments`
WHEN OLD.`state` = 'revoked'
  AND (NEW.`due_at` IS NOT OLD.`due_at` OR NEW.`updated_at` IS NOT OLD.`updated_at`)
BEGIN
  SELECT RAISE(ABORT, 'a revoked review assignment cannot change');
END;

CREATE TRIGGER `reviews_valid_assignment_insert`
BEFORE INSERT ON `reviews`
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (
      SELECT 1
      FROM `review_assignments` AS assignment
      INNER JOIN `proposals` AS proposal
        ON proposal.`id` = assignment.`proposal_id`
        AND proposal.`event_id` = assignment.`event_id`
      INNER JOIN `event_memberships` AS membership
        ON membership.`event_id` = assignment.`event_id`
        AND membership.`user_id` = assignment.`reviewer_user_id`
        AND membership.`role` = 'reviewer'
      WHERE assignment.`id` = NEW.`assignment_id`
        AND assignment.`event_id` = NEW.`event_id`
        AND assignment.`state` = 'assigned'
        AND proposal.`status` IN ('submitted', 'in_review')
    )
    OR EXISTS (
      SELECT 1
      FROM `review_assignments` AS assignment
      INNER JOIN `proposals` AS proposal
        ON proposal.`id` = assignment.`proposal_id`
        AND proposal.`event_id` = assignment.`event_id`
      LEFT JOIN `proposal_presenters` AS presenter
        ON presenter.`event_id` = proposal.`event_id`
        AND presenter.`proposal_id` = proposal.`id`
      LEFT JOIN `speakers` AS speaker
        ON speaker.`event_id` = presenter.`event_id`
        AND speaker.`id` = presenter.`speaker_id`
      WHERE assignment.`id` = NEW.`assignment_id`
        AND assignment.`event_id` = NEW.`event_id`
        AND (
          proposal.`owner_user_id` IS assignment.`reviewer_user_id`
          OR speaker.`user_id` IS assignment.`reviewer_user_id`
        )
    )
  THEN RAISE(ABORT, 'review must belong to one active event assignment and cannot be self-review') END;
END;

CREATE TRIGGER `reviews_immutable_update`
BEFORE UPDATE ON `reviews`
BEGIN
  SELECT RAISE(ABORT, 'submitted reviews are immutable');
END;

CREATE TRIGGER `reviews_immutable_delete`
BEFORE DELETE ON `reviews`
BEGIN
  SELECT RAISE(ABORT, 'submitted reviews are immutable');
END;
