-- Permit additional review after an immutable decision only inside an explicit open round.

DROP TRIGGER IF EXISTS `review_assignments_scope_insert`;
CREATE TRIGGER `review_assignments_scope_insert`
BEFORE INSERT ON `review_assignments`
BEGIN
  SELECT CASE WHEN NEW.`state` IS NOT 'assigned'
  THEN RAISE(ABORT, 'review assignment must start assigned') END;
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) IS NOT NEW.`event_id`
    OR NOT EXISTS (
      SELECT 1 FROM `proposals` AS proposal
      WHERE proposal.`id` = NEW.`proposal_id`
        AND proposal.`event_id` = NEW.`event_id`
        AND (
          proposal.`status` IN ('submitted', 'in_review')
          OR (
            proposal.`status` = 'decided'
            AND NEW.`review_round_id` IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM `review_rounds` AS round
              WHERE round.`id` = NEW.`review_round_id`
                AND round.`event_id` = NEW.`event_id`
                AND round.`opens_at` <= NEW.`created_at`
                AND round.`closes_at` > NEW.`created_at`
            )
          )
        )
    )
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

DROP TRIGGER IF EXISTS `reviews_valid_assignment_insert`;
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
        AND (
          proposal.`status` IN ('submitted', 'in_review')
          OR (
            proposal.`status` = 'decided'
            AND assignment.`review_round_id` IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM `review_rounds` AS round
              WHERE round.`id` = assignment.`review_round_id`
                AND round.`event_id` = assignment.`event_id`
                AND round.`opens_at` <= NEW.`submitted_at`
                AND round.`closes_at` > NEW.`submitted_at`
            )
          )
        )
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
