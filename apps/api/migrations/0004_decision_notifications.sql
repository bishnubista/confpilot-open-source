PRAGMA defer_foreign_keys = true;

DROP TRIGGER IF EXISTS `decisions_scope_insert`;

CREATE TRIGGER `decisions_scope_insert`
BEFORE INSERT ON `decisions`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `proposals`
    WHERE `id` = NEW.`proposal_id`
      AND `event_id` = NEW.`event_id`
      AND `status` IN ('submitted', 'in_review', 'decided')
  ) OR NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`decided_by_user_id`
      AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'decision must use a submitted or reviewed event proposal and an event organizer') END;

  UPDATE `proposals`
  SET `status` = 'decided', `updated_at` = NEW.`decided_at`
  WHERE `id` = NEW.`proposal_id` AND `event_id` = NEW.`event_id`;
END;

DROP TRIGGER IF EXISTS `notification_outbox_valid_chain_insert`;
DROP TRIGGER IF EXISTS `notification_outbox_identity_immutable_update`;

ALTER TABLE `notification_outbox` RENAME TO `notification_outbox_legacy_0004`;

CREATE TABLE `notification_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `decision_id` text NOT NULL,
  `acceptance_id` text,
  `recipient_speaker_id` text NOT NULL,
  `recipient_user_id` text,
  `recipient_name` text NOT NULL,
  `recipient_email` text,
  `queued_by_user_id` text NOT NULL,
  `subject` text NOT NULL,
  `body` text NOT NULL,
  `state` text DEFAULT 'pending' NOT NULL,
  `queued_at` text NOT NULL,
  `sent_at` text,
  `failure_message` text,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`decision_id`) REFERENCES `decisions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`acceptance_id`) REFERENCES `acceptances` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`recipient_speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`recipient_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`queued_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (
    (`recipient_user_id` IS NULL AND `recipient_email` IS NULL)
    OR (
      `recipient_user_id` IS NOT NULL
      AND `recipient_email` IS NOT NULL
      AND `recipient_email` = lower(trim(`recipient_email`))
      AND length(`recipient_email`) BETWEEN 3 AND 254
    )
  ),
  CHECK (length(trim(`recipient_name`)) BETWEEN 1 AND 120),
  CHECK (`subject` = trim(`subject`) AND length(`subject`) BETWEEN 1 AND 998),
  CHECK (`body` = trim(`body`) AND length(`body`) BETWEEN 1 AND 20000),
  CHECK (`state` IN ('pending', 'sent', 'failed')),
  CHECK (`queued_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `queued_at`)),
  CHECK (`sent_at` IS NULL OR `sent_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `sent_at`)),
  CHECK (
    (`state` = 'pending' AND `sent_at` IS NULL AND `failure_message` IS NULL)
    OR (`state` = 'sent' AND `sent_at` IS NOT NULL AND `failure_message` IS NULL)
    OR (
      `state` = 'failed'
      AND `sent_at` IS NULL
      AND length(trim(`failure_message`)) BETWEEN 1 AND 1000
    )
  )
);

INSERT INTO `notification_outbox` (
  `id`, `event_id`, `decision_id`, `acceptance_id`, `recipient_speaker_id`,
  `recipient_user_id`, `recipient_name`, `recipient_email`, `queued_by_user_id`,
  `subject`, `body`, `state`, `queued_at`, `sent_at`, `failure_message`
)
SELECT
  legacy.`id`,
  legacy.`event_id`,
  legacy.`decision_id`,
  legacy.`acceptance_id`,
  legacy.`recipient_speaker_id`,
  CASE
    WHEN speaker.`user_id` IS NOT NULL
      AND length(lower(trim(COALESCE(user.`email`, '')))) BETWEEN 3 AND 254
      THEN speaker.`user_id`
    ELSE NULL
  END,
  CASE
    WHEN length(trim(
      COALESCE(speaker.`name`, ''),
      char(9) || char(10) || char(11) || char(12) || char(13) || ' '
    )) = 0
      THEN 'Legacy speaker'
    ELSE substr(trim(
      speaker.`name`,
      char(9) || char(10) || char(11) || char(12) || char(13) || ' '
    ), 1, 120)
  END,
  CASE
    WHEN speaker.`user_id` IS NOT NULL
      AND length(lower(trim(COALESCE(user.`email`, '')))) BETWEEN 3 AND 254
      THEN lower(trim(user.`email`))
    ELSE NULL
  END,
  acceptance.`accepted_by_user_id`,
  CASE
    WHEN length(trim(
      COALESCE(legacy.`subject`, ''),
      char(9) || char(10) || char(11) || char(12) || char(13) || ' '
    )) = 0
      THEN 'Program decision notification'
    ELSE rtrim(substr(trim(
      legacy.`subject`,
      char(9) || char(10) || char(11) || char(12) || char(13) || ' '
    ), 1, 998), char(9) || char(10) || char(11) || char(12) || char(13) || ' ')
  END,
  'Legacy notification body unavailable',
  legacy.`state`,
  COALESCE(
    strftime('%Y-%m-%dT%H:%M:%SZ', legacy.`queued_at`),
    '1970-01-01T00:00:00Z'
  ),
  CASE
    WHEN legacy.`state` = 'sent' THEN COALESCE(
      strftime('%Y-%m-%dT%H:%M:%SZ', legacy.`sent_at`),
      strftime('%Y-%m-%dT%H:%M:%SZ', legacy.`queued_at`),
      '1970-01-01T00:00:00Z'
    )
    ELSE NULL
  END,
  CASE WHEN legacy.`state` = 'failed' THEN 'Legacy delivery failed' ELSE NULL END
FROM `notification_outbox_legacy_0004` AS legacy
INNER JOIN `acceptances` AS acceptance
  ON acceptance.`id` = legacy.`acceptance_id`
  AND acceptance.`event_id` = legacy.`event_id`
  AND acceptance.`decision_id` = legacy.`decision_id`
INNER JOIN `speakers` AS speaker
  ON speaker.`id` = legacy.`recipient_speaker_id`
  AND speaker.`event_id` = legacy.`event_id`
LEFT JOIN `users` AS user ON user.`id` = speaker.`user_id`;

DROP TABLE `notification_outbox_legacy_0004`;

CREATE UNIQUE INDEX `notification_outbox_event_decision_recipient_unique`
  ON `notification_outbox` (`event_id`, `decision_id`, `recipient_speaker_id`);
CREATE INDEX `notification_outbox_event_state_queue_index`
  ON `notification_outbox` (`event_id`, `state`, `queued_at`);

CREATE TRIGGER `notification_outbox_valid_chain_insert`
BEFORE INSERT ON `notification_outbox`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM `decisions` AS decision
    INNER JOIN `proposals` AS proposal
      ON proposal.`id` = decision.`proposal_id`
      AND proposal.`event_id` = decision.`event_id`
    INNER JOIN `proposal_presenters` AS presenter
      ON presenter.`event_id` = decision.`event_id`
      AND presenter.`proposal_id` = decision.`proposal_id`
      AND presenter.`role` = 'primary'
    INNER JOIN `speakers` AS speaker
      ON speaker.`id` = presenter.`speaker_id`
      AND speaker.`event_id` = presenter.`event_id`
    INNER JOIN `users` AS owner ON owner.`id` = proposal.`owner_user_id`
    WHERE decision.`id` = NEW.`decision_id`
      AND decision.`event_id` = NEW.`event_id`
      AND proposal.`owner_user_id` = NEW.`recipient_user_id`
      AND speaker.`id` = NEW.`recipient_speaker_id`
      AND speaker.`user_id` = NEW.`recipient_user_id`
      AND owner.`display_name` = NEW.`recipient_name`
      AND lower(trim(owner.`email`)) = NEW.`recipient_email`
  ) THEN RAISE(ABORT, 'notification must target the decided proposal owner and primary presenter') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`queued_by_user_id`
      AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'notification must be queued by an event organizer') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `decisions`
    WHERE `id` = NEW.`decision_id`
      AND `event_id` = NEW.`event_id`
      AND `decision` = 'accept'
  ) AND NOT EXISTS (
    SELECT 1 FROM `acceptances`
    WHERE `id` = NEW.`acceptance_id`
      AND `event_id` = NEW.`event_id`
      AND `decision_id` = NEW.`decision_id`
  ) THEN RAISE(ABORT, 'accepted decision notification requires its materialized acceptance') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `decisions`
    WHERE `id` = NEW.`decision_id`
      AND `event_id` = NEW.`event_id`
      AND `decision` IN ('reject', 'waitlist')
  ) AND NEW.`acceptance_id` IS NOT NULL
  THEN RAISE(ABORT, 'non-accepted decision notification cannot reference an acceptance') END;
END;

CREATE TRIGGER `notification_outbox_content_immutable_update`
BEFORE UPDATE OF
  `id`, `event_id`, `decision_id`, `acceptance_id`, `recipient_speaker_id`,
  `recipient_user_id`, `recipient_name`, `recipient_email`, `queued_by_user_id`,
  `subject`, `body`, `queued_at`
ON `notification_outbox`
BEGIN
  SELECT RAISE(ABORT, 'notification identity and queued content are immutable');
END;

CREATE TRIGGER `notification_outbox_state_forward_only_update`
BEFORE UPDATE OF `state`, `sent_at`, `failure_message` ON `notification_outbox`
WHEN NOT (
  OLD.`state` = 'pending'
  AND (
    (NEW.`state` = 'sent' AND NEW.`sent_at` IS NOT NULL AND NEW.`failure_message` IS NULL)
    OR (
      NEW.`state` = 'failed'
      AND NEW.`sent_at` IS NULL
      AND length(trim(NEW.`failure_message`)) BETWEEN 1 AND 1000
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'notification delivery state is terminal and forward-only');
END;

CREATE TRIGGER `notification_outbox_immutable_delete`
BEFORE DELETE ON `notification_outbox`
BEGIN
  SELECT RAISE(ABORT, 'notification history cannot be deleted');
END;
