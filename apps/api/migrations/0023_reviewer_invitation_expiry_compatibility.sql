PRAGMA defer_foreign_keys = true;

-- The applied draft's 0018 transition trigger names NEW.expired_at even when
-- that column is absent, so it must be removed before SQLite can rename the
-- legacy table. The replacement guards are recreated after the rebuild.
DROP TRIGGER IF EXISTS `reviewer_invitation_acceptances_no_delete`;
DROP TRIGGER IF EXISTS `reviewer_invitation_acceptances_immutable`;
DROP TRIGGER IF EXISTS `reviewer_invitation_acceptances_insert_guard`;
DROP TRIGGER IF EXISTS `reviewer_invitations_transition_guard`;
DROP TRIGGER IF EXISTS `reviewer_invitations_identity_immutable`;
DROP TRIGGER IF EXISTS `reviewer_invitations_insert_guard`;

ALTER TABLE `reviewer_invitation_acceptances`
  RENAME TO `reviewer_invitation_acceptances_legacy_0023`;
ALTER TABLE `reviewer_invitations`
  RENAME TO `reviewer_invitations_legacy_0023`;

CREATE TABLE `reviewer_invitations` (
  `id` TEXT PRIMARY KEY,
  `event_id` TEXT NOT NULL REFERENCES `events` (`id`) ON DELETE RESTRICT,
  `email` TEXT NOT NULL,
  `display_name` TEXT NOT NULL,
  `token_hash` TEXT NOT NULL UNIQUE,
  `idempotency_key` TEXT NOT NULL,
  `state` TEXT NOT NULL DEFAULT 'pending' CHECK (`state` IN ('pending', 'accepted', 'revoked', 'expired')),
  `expires_at` TEXT NOT NULL,
  `invited_by_user_id` TEXT NOT NULL REFERENCES `users` (`id`) ON DELETE RESTRICT,
  `accepted_by_user_id` TEXT REFERENCES `users` (`id`) ON DELETE RESTRICT,
  `revoked_by_user_id` TEXT REFERENCES `users` (`id`) ON DELETE RESTRICT,
  `outbox_message_id` TEXT NOT NULL REFERENCES `message_outbox` (`id`) ON DELETE RESTRICT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  `accepted_at` TEXT,
  `revoked_at` TEXT,
  `expired_at` TEXT,
  UNIQUE (`event_id`, `idempotency_key`),
  CHECK (`email` = lower(trim(`email`)) AND length(`email`) BETWEEN 3 AND 254),
  CHECK (length(trim(`display_name`)) BETWEEN 2 AND 120),
  CHECK (length(`token_hash`) = 64 AND `token_hash` NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(trim(`idempotency_key`)) BETWEEN 8 AND 128),
  CHECK (`expires_at` > `created_at` AND `updated_at` >= `created_at`),
  CHECK (
    (`state` = 'pending' AND `accepted_by_user_id` IS NULL AND `accepted_at` IS NULL AND `revoked_by_user_id` IS NULL AND `revoked_at` IS NULL AND `expired_at` IS NULL)
    OR (`state` = 'accepted' AND `accepted_by_user_id` IS NOT NULL AND `accepted_at` IS NOT NULL AND `revoked_by_user_id` IS NULL AND `revoked_at` IS NULL AND `expired_at` IS NULL)
    OR (`state` = 'revoked' AND `accepted_by_user_id` IS NULL AND `accepted_at` IS NULL AND `revoked_by_user_id` IS NOT NULL AND `revoked_at` IS NOT NULL AND `expired_at` IS NULL)
    OR (`state` = 'expired' AND `accepted_by_user_id` IS NULL AND `accepted_at` IS NULL AND `revoked_by_user_id` IS NULL AND `revoked_at` IS NULL AND `expired_at` = `expires_at`)
  )
);

INSERT INTO `reviewer_invitations` (
  `id`, `event_id`, `email`, `display_name`, `token_hash`, `idempotency_key`, `state`,
  `expires_at`, `invited_by_user_id`, `accepted_by_user_id`, `revoked_by_user_id`,
  `outbox_message_id`, `created_at`, `updated_at`, `accepted_at`, `revoked_at`, `expired_at`
)
SELECT
  `id`, `event_id`, `email`, `display_name`, `token_hash`, `idempotency_key`, `state`,
  `expires_at`, `invited_by_user_id`, `accepted_by_user_id`, `revoked_by_user_id`,
  `outbox_message_id`, `created_at`, `updated_at`, `accepted_at`, `revoked_at`,
  CASE WHEN `state` = 'expired' THEN `expires_at` ELSE NULL END
FROM `reviewer_invitations_legacy_0023`;

CREATE TABLE `reviewer_invitation_acceptances` (
  `invitation_id` TEXT PRIMARY KEY REFERENCES `reviewer_invitations` (`id`) ON DELETE RESTRICT,
  `event_id` TEXT NOT NULL REFERENCES `events` (`id`) ON DELETE RESTRICT,
  `user_id` TEXT NOT NULL REFERENCES `users` (`id`) ON DELETE RESTRICT,
  `accepted_at` TEXT NOT NULL,
  UNIQUE (`event_id`, `user_id`)
);

INSERT INTO `reviewer_invitation_acceptances` (`invitation_id`, `event_id`, `user_id`, `accepted_at`)
SELECT `invitation_id`, `event_id`, `user_id`, `accepted_at`
FROM `reviewer_invitation_acceptances_legacy_0023`;

DROP TABLE `reviewer_invitation_acceptances_legacy_0023`;
DROP TABLE `reviewer_invitations_legacy_0023`;

CREATE UNIQUE INDEX `reviewer_invitations_pending_email_unique`
  ON `reviewer_invitations` (`event_id`, `email`) WHERE `state` = 'pending';
CREATE INDEX `reviewer_invitations_event_created`
  ON `reviewer_invitations` (`event_id`, `created_at` DESC, `id` DESC);

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

CREATE TRIGGER `reviewer_invitations_identity_immutable`
BEFORE UPDATE ON `reviewer_invitations`
WHEN NEW.`id` != OLD.`id`
  OR NEW.`event_id` != OLD.`event_id`
  OR NEW.`email` != OLD.`email`
  OR NEW.`display_name` != OLD.`display_name`
  OR NEW.`token_hash` != OLD.`token_hash`
  OR NEW.`idempotency_key` != OLD.`idempotency_key`
  OR NEW.`expires_at` != OLD.`expires_at`
  OR NEW.`invited_by_user_id` != OLD.`invited_by_user_id`
  OR NEW.`outbox_message_id` != OLD.`outbox_message_id`
  OR NEW.`created_at` != OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'reviewer invitation identity is immutable');
END;

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

CREATE TRIGGER `reviewer_invitation_acceptances_insert_guard`
BEFORE INSERT ON `reviewer_invitation_acceptances`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `reviewer_invitations`
    WHERE `id` = NEW.`invitation_id`
      AND `event_id` = NEW.`event_id`
      AND `state` = 'accepted'
      AND `accepted_by_user_id` = NEW.`user_id`
      AND `accepted_at` = NEW.`accepted_at`
  ) THEN RAISE(ABORT, 'reviewer invitation acceptance receipt mismatch') END;
END;

CREATE TRIGGER `reviewer_invitation_acceptances_immutable`
BEFORE UPDATE ON `reviewer_invitation_acceptances`
BEGIN
  SELECT RAISE(ABORT, 'reviewer invitation acceptance is immutable');
END;

CREATE TRIGGER `reviewer_invitation_acceptances_no_delete`
BEFORE DELETE ON `reviewer_invitation_acceptances`
BEGIN
  SELECT RAISE(ABORT, 'reviewer invitation acceptance is immutable');
END;
