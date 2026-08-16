DROP INDEX IF EXISTS `event_memberships_event_user_unique`;

CREATE UNIQUE INDEX IF NOT EXISTS `event_memberships_event_user_role_unique`
  ON `event_memberships` (`event_id`, `user_id`, `role`);

DROP TRIGGER IF EXISTS `speaker_claim_insert_guard`;
CREATE TRIGGER `speaker_claim_insert_guard`
BEFORE INSERT ON `speaker_claim_invitations`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships` WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`invited_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'speaker claim requires same-event organizer') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `speakers` WHERE `id` = NEW.`speaker_id` AND `event_id` = NEW.`event_id`
      AND `user_id` IS NULL AND lower(trim(`contact_email`)) = NEW.`email`
  ) THEN RAISE(ABORT, 'speaker claim target mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `users` AS user INNER JOIN `event_memberships` AS membership
      ON membership.`user_id` = user.`id` AND membership.`event_id` = NEW.`event_id`
      AND membership.`role` = 'speaker'
    WHERE lower(trim(user.`email`)) = NEW.`email`
  ) THEN RAISE(ABORT, 'speaker claim email already has speaker access') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `message_outbox` WHERE `id` = NEW.`outbox_message_id`
      AND `event_id` = NEW.`event_id` AND `actor_user_id` = NEW.`invited_by_user_id`
      AND `intent` = 'speaker_claim_invitation' AND `recipient_email` = NEW.`email`
      AND `recipient_name` = (SELECT `name` FROM `speakers` WHERE `id` = NEW.`speaker_id`)
      AND `expires_at` = NEW.`expires_at` AND `canceled_at` IS NULL
  ) THEN RAISE(ABORT, 'speaker claim outbox mismatch') END;
END;

DROP TRIGGER IF EXISTS `speaker_claim_transition_guard`;
CREATE TRIGGER `speaker_claim_transition_guard`
BEFORE UPDATE ON `speaker_claim_invitations`
BEGIN
  SELECT CASE WHEN OLD.`state` != 'pending' OR NEW.`state` NOT IN ('accepted', 'revoked', 'expired')
    THEN RAISE(ABORT, 'invalid speaker claim transition') END;
  SELECT CASE WHEN NEW.`updated_at` < OLD.`updated_at`
    THEN RAISE(ABORT, 'speaker claim timestamp cannot move backward') END;
  SELECT CASE WHEN NEW.`state` = 'accepted' AND (
    NEW.`accepted_at` != NEW.`updated_at`
    OR NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = NEW.`accepted_by_user_id` AND lower(trim(`email`)) = NEW.`email`)
    OR NOT EXISTS (SELECT 1 FROM `speakers` WHERE `id` = NEW.`speaker_id` AND `event_id` = NEW.`event_id`
      AND `user_id` IS NULL AND lower(trim(`contact_email`)) = NEW.`email`)
    OR EXISTS (SELECT 1 FROM `event_memberships` WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`accepted_by_user_id` AND `role` = 'speaker')
  ) THEN RAISE(ABORT, 'speaker claim acceptance identity mismatch') END;
  SELECT CASE WHEN NEW.`state` = 'revoked' AND (
    NEW.`revoked_at` != NEW.`updated_at` OR NOT EXISTS (
      SELECT 1 FROM `event_memberships` WHERE `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`revoked_by_user_id` AND `role` = 'organizer'
    )
  ) THEN RAISE(ABORT, 'speaker claim revocation requires same-event organizer') END;
  SELECT CASE WHEN NEW.`state` = 'expired' AND (NEW.`expired_at` != OLD.`expires_at` OR NEW.`updated_at` < OLD.`expires_at`)
    THEN RAISE(ABORT, 'speaker claim expiry is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `message_outbox` WHERE `id` = NEW.`outbox_message_id` AND (
      `state` IN ('delivered', 'failed') OR (`canceled_at` IS NOT NULL AND `cancellation_code` = CASE NEW.`state`
        WHEN 'accepted' THEN 'INVITATION_ACCEPTED' WHEN 'revoked' THEN 'INVITATION_REVOKED'
        WHEN 'expired' THEN 'MESSAGE_EXPIRED' END)
    )
  ) THEN RAISE(ABORT, 'speaker claim outbox transition mismatch') END;
END;

DROP TRIGGER IF EXISTS `reviewer_invitations_insert_guard`;
CREATE TRIGGER `reviewer_invitations_insert_guard`
BEFORE INSERT ON `reviewer_invitations`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`invited_by_user_id`
      AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'reviewer invitation requires same-event organizer') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `users` AS user
    INNER JOIN `event_memberships` AS membership
      ON membership.`user_id` = user.`id` AND membership.`event_id` = NEW.`event_id`
      AND membership.`role` = 'reviewer'
    WHERE lower(trim(user.`email`)) = NEW.`email`
  ) THEN RAISE(ABORT, 'reviewer invitation email already has reviewer access') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `message_outbox` AS message
    WHERE message.`id` = NEW.`outbox_message_id`
      AND message.`event_id` = NEW.`event_id`
      AND message.`actor_user_id` = NEW.`invited_by_user_id`
      AND message.`intent` = 'reviewer_invitation'
      AND message.`recipient_email` = NEW.`email`
      AND message.`expires_at` = NEW.`expires_at`
      AND message.`canceled_at` IS NULL
  ) THEN RAISE(ABORT, 'reviewer invitation outbox mismatch') END;
END;

DROP TRIGGER IF EXISTS `reviewer_invitations_transition_guard`;
CREATE TRIGGER `reviewer_invitations_transition_guard`
BEFORE UPDATE ON `reviewer_invitations`
BEGIN
  SELECT CASE WHEN OLD.`state` != 'pending' OR NEW.`state` NOT IN ('accepted', 'revoked', 'expired')
    THEN RAISE(ABORT, 'invalid reviewer invitation transition') END;
  SELECT CASE WHEN NEW.`updated_at` < OLD.`updated_at`
    THEN RAISE(ABORT, 'reviewer invitation update timestamp cannot move backward') END;
  SELECT CASE WHEN NEW.`state` = 'accepted' AND (
    NEW.`accepted_at` != NEW.`updated_at`
    OR NOT EXISTS (
      SELECT 1 FROM `users`
      WHERE `id` = NEW.`accepted_by_user_id` AND lower(trim(`email`)) = NEW.`email`
    )
    OR EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`accepted_by_user_id`
        AND `role` = 'reviewer'
    )
  ) THEN RAISE(ABORT, 'reviewer invitation acceptance identity mismatch') END;
  SELECT CASE WHEN NEW.`state` = 'revoked' AND (
    NEW.`revoked_at` != NEW.`updated_at`
    OR NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`revoked_by_user_id`
        AND `role` = 'organizer'
    )
  ) THEN RAISE(ABORT, 'reviewer invitation revocation requires same-event organizer') END;
  SELECT CASE WHEN NEW.`state` = 'expired' AND (
    NEW.`expired_at` != OLD.`expires_at`
    OR NEW.`updated_at` < OLD.`expires_at`
  ) THEN RAISE(ABORT, 'reviewer invitation expiry is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `message_outbox`
    WHERE `id` = NEW.`outbox_message_id`
      AND (
        `state` IN ('delivered', 'failed')
        OR (`canceled_at` IS NOT NULL AND `cancellation_code` = CASE NEW.`state`
          WHEN 'accepted' THEN 'INVITATION_ACCEPTED'
          WHEN 'revoked' THEN 'INVITATION_REVOKED'
          WHEN 'expired' THEN 'MESSAGE_EXPIRED'
        END)
      )
  ) THEN RAISE(ABORT, 'reviewer invitation outbox transition mismatch') END;
END;
