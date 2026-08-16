ALTER TABLE `review_assignments` ADD COLUMN `requires_response` integer DEFAULT 0 NOT NULL
  CHECK (`requires_response` IN (0, 1));

DROP TRIGGER `review_assignments_identity_immutable_update`;
CREATE TRIGGER `review_assignments_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `proposal_id`, `reviewer_user_id`, `created_by_user_id`,
  `round`, `blind`, `created_at`, `review_plan_version_id`, `requires_response`
ON `review_assignments`
BEGIN
  SELECT RAISE(ABORT, 'review assignment identity is immutable');
END;

CREATE TABLE `review_assignment_actions` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `assignment_id` text NOT NULL,
  `reviewer_user_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `action` text NOT NULL,
  `reason` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`assignment_id`) REFERENCES `review_assignments` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`reviewer_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`sequence` IN (1, 2)),
  CHECK (`action` IN ('accepted', 'declined', 'recused')),
  CHECK (
    (`action` = 'accepted' AND `reason` IS NULL)
    OR (`action` IN ('declined', 'recused') AND length(trim(`reason`)) BETWEEN 1 AND 1000)
  )
);
CREATE UNIQUE INDEX `review_assignment_actions_assignment_sequence_unique`
  ON `review_assignment_actions` (`assignment_id`, `sequence`);
CREATE INDEX `review_assignment_actions_event_reviewer_index`
  ON `review_assignment_actions` (`event_id`, `reviewer_user_id`, `created_at`);

CREATE TRIGGER `review_assignment_actions_valid_insert`
BEFORE INSERT ON `review_assignment_actions`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM `review_assignments` AS assignment
    INNER JOIN `event_memberships` AS membership
      ON membership.`event_id` = assignment.`event_id`
      AND membership.`user_id` = assignment.`reviewer_user_id`
      AND membership.`role` = 'reviewer'
    WHERE assignment.`id` = NEW.`assignment_id`
      AND assignment.`event_id` = NEW.`event_id`
      AND assignment.`reviewer_user_id` = NEW.`reviewer_user_id`
      AND assignment.`state` = 'assigned'
  ) OR EXISTS (
    SELECT 1 FROM `reviews` WHERE `assignment_id` = NEW.`assignment_id`
  ) THEN RAISE(ABORT, 'review assignment action requires its active event reviewer and no submitted review') END;

  SELECT CASE WHEN
    (NEW.`sequence` = 1 AND (
      NEW.`action` NOT IN ('accepted', 'declined')
      OR EXISTS (SELECT 1 FROM `review_assignment_actions` WHERE `assignment_id` = NEW.`assignment_id`)
    ))
    OR (NEW.`sequence` = 2 AND (
      NEW.`action` != 'recused'
      OR NOT EXISTS (
        SELECT 1 FROM `review_assignment_actions`
        WHERE `assignment_id` = NEW.`assignment_id` AND `sequence` = 1 AND `action` = 'accepted'
      )
      OR EXISTS (
        SELECT 1 FROM `review_assignment_actions`
        WHERE `assignment_id` = NEW.`assignment_id` AND `sequence` = 2
      )
    ))
  THEN RAISE(ABORT, 'review assignment action is not a valid lifecycle transition') END;
END;

CREATE TRIGGER `review_assignment_actions_immutable_update`
BEFORE UPDATE ON `review_assignment_actions`
BEGIN
  SELECT RAISE(ABORT, 'review assignment actions are immutable');
END;
CREATE TRIGGER `review_assignment_actions_immutable_delete`
BEFORE DELETE ON `review_assignment_actions`
BEGIN
  SELECT RAISE(ABORT, 'review assignment actions are immutable');
END;

CREATE TABLE `reviewer_conflicts` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `proposal_id` text NOT NULL,
  `reviewer_user_id` text NOT NULL,
  `assignment_id` text NOT NULL,
  `category` text NOT NULL,
  `note` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`proposal_id`) REFERENCES `proposals` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`reviewer_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`assignment_id`) REFERENCES `review_assignments` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`category` IN ('author_relationship', 'institutional', 'financial', 'personal', 'other')),
  CHECK (length(trim(`note`)) BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX `reviewer_conflicts_event_proposal_reviewer_unique`
  ON `reviewer_conflicts` (`event_id`, `proposal_id`, `reviewer_user_id`);
CREATE UNIQUE INDEX `reviewer_conflicts_assignment_unique`
  ON `reviewer_conflicts` (`assignment_id`);
CREATE INDEX `reviewer_conflicts_event_proposal_index`
  ON `reviewer_conflicts` (`event_id`, `proposal_id`, `created_at`);

CREATE TRIGGER `review_assignments_conflict_insert`
BEFORE INSERT ON `review_assignments`
WHEN EXISTS (
  SELECT 1 FROM `reviewer_conflicts`
  WHERE `event_id` = NEW.`event_id`
    AND `proposal_id` = NEW.`proposal_id`
    AND `reviewer_user_id` = NEW.`reviewer_user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'review assignment cannot override a declared reviewer conflict');
END;

CREATE TRIGGER `reviewer_conflicts_valid_insert`
BEFORE INSERT ON `reviewer_conflicts`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM `review_assignments` AS assignment
    INNER JOIN `event_memberships` AS membership
      ON membership.`event_id` = assignment.`event_id`
      AND membership.`user_id` = assignment.`reviewer_user_id`
      AND membership.`role` = 'reviewer'
    WHERE assignment.`id` = NEW.`assignment_id`
      AND assignment.`event_id` = NEW.`event_id`
      AND assignment.`proposal_id` = NEW.`proposal_id`
      AND assignment.`reviewer_user_id` = NEW.`reviewer_user_id`
      AND assignment.`state` = 'assigned'
      AND NOT EXISTS (SELECT 1 FROM `reviews` WHERE `assignment_id` = assignment.`id`)
      AND EXISTS (
        SELECT 1 FROM `review_assignment_actions`
        WHERE `assignment_id` = assignment.`id` AND `action` IN ('declined', 'recused')
      )
  ) THEN RAISE(ABORT, 'reviewer conflict must match an active assignment owned by the event reviewer') END;
END;

CREATE TRIGGER `reviewer_conflicts_immutable_update`
BEFORE UPDATE ON `reviewer_conflicts`
BEGIN
  SELECT RAISE(ABORT, 'reviewer conflict declarations are immutable');
END;
CREATE TRIGGER `reviewer_conflicts_immutable_delete`
BEFORE DELETE ON `reviewer_conflicts`
BEGIN
  SELECT RAISE(ABORT, 'reviewer conflict declarations are immutable');
END;

DROP TRIGGER `reviews_valid_assignment_insert`;
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
        AND (
          assignment.`requires_response` = 0
          OR EXISTS (
            SELECT 1 FROM `review_assignment_actions`
            WHERE `assignment_id` = assignment.`id` AND `sequence` = 1 AND `action` = 'accepted'
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM `review_assignment_actions`
          WHERE `assignment_id` = assignment.`id` AND `action` IN ('declined', 'recused')
        )
        AND NOT EXISTS (
          SELECT 1 FROM `reviewer_conflicts`
          WHERE `assignment_id` = assignment.`id`
        )
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
  THEN RAISE(ABORT, 'review must belong to one accepted active event assignment without conflict and cannot be self-review') END;
END;
