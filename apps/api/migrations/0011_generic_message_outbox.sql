CREATE TABLE `message_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `actor_user_id` text,
  `dedupe_key` text NOT NULL,
  `intent` text NOT NULL,
  `recipient_email` text NOT NULL,
  `recipient_name` text NOT NULL,
  `template_key` text NOT NULL,
  `template_revision` integer NOT NULL,
  `subject` text NOT NULL,
  `text_body` text NOT NULL,
  `content_sha256` text NOT NULL,
  `state` text DEFAULT 'queued' NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` text NOT NULL,
  `lease_expires_at` text,
  `lease_token` text,
  `provider` text,
  `provider_message_id` text,
  `last_error_code` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `delivered_at` text,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  UNIQUE (`event_id`, `dedupe_key`),
  CHECK (length(`dedupe_key`) BETWEEN 1 AND 200),
  CHECK (`intent` GLOB '[a-z0-9]*' AND `intent` NOT GLOB '*[^a-z0-9_-]*' AND length(`intent`) BETWEEN 1 AND 80),
  CHECK (`recipient_email` = lower(trim(`recipient_email`)) AND length(`recipient_email`) BETWEEN 3 AND 254),
  CHECK (length(trim(`recipient_name`)) BETWEEN 1 AND 120),
  CHECK (`template_key` GLOB '[a-z0-9]*' AND `template_key` NOT GLOB '*[^a-z0-9_.-]*' AND length(`template_key`) BETWEEN 1 AND 120),
  CHECK (`template_revision` >= 1),
  CHECK (`subject` = trim(`subject`) AND length(`subject`) BETWEEN 1 AND 998),
  CHECK (`text_body` = trim(`text_body`) AND length(`text_body`) BETWEEN 1 AND 20000),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^0-9a-f]*'),
  CHECK (`state` IN ('queued', 'leased', 'delivered', 'failed')),
  CHECK (`attempt_count` BETWEEN 0 AND 20),
  CHECK (`next_attempt_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `next_attempt_at`)),
  CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`)),
  CHECK (`updated_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`)),
  CHECK (`lease_expires_at` IS NULL OR `lease_expires_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `lease_expires_at`)),
  CHECK (`lease_token` IS NULL OR (length(`lease_token`) BETWEEN 16 AND 100 AND `lease_token` NOT GLOB '*[^A-Za-z0-9_-]*')),
  CHECK (`delivered_at` IS NULL OR `delivered_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `delivered_at`)),
  CHECK (`provider` IS NULL OR length(`provider`) BETWEEN 1 AND 80),
  CHECK (`provider_message_id` IS NULL OR length(`provider_message_id`) BETWEEN 1 AND 500),
  CHECK (`last_error_code` IS NULL OR (`last_error_code` GLOB '[A-Z0-9]*' AND `last_error_code` NOT GLOB '*[^A-Z0-9_]*' AND length(`last_error_code`) BETWEEN 1 AND 80)),
  CHECK (
    (`state` = 'queued' AND `lease_expires_at` IS NULL AND `lease_token` IS NULL AND `delivered_at` IS NULL AND `provider_message_id` IS NULL)
    OR (`state` = 'leased' AND `attempt_count` >= 1 AND `lease_expires_at` IS NOT NULL AND `lease_token` IS NOT NULL AND `delivered_at` IS NULL AND `provider_message_id` IS NULL)
    OR (`state` = 'delivered' AND `attempt_count` >= 1 AND `lease_expires_at` IS NULL AND `lease_token` IS NULL AND `delivered_at` IS NOT NULL AND `provider` IS NOT NULL AND `last_error_code` IS NULL)
    OR (`state` = 'failed' AND `attempt_count` >= 1 AND `lease_expires_at` IS NULL AND `lease_token` IS NULL AND `delivered_at` IS NULL AND `provider_message_id` IS NULL AND `last_error_code` IS NOT NULL)
  )
);

CREATE INDEX `message_outbox_delivery_queue_index`
  ON `message_outbox` (`state`, `next_attempt_at`, `created_at`);

CREATE TRIGGER `message_outbox_actor_valid_insert`
BEFORE INSERT ON `message_outbox`
WHEN
  (NEW.`intent` = 'speaker_reminder' AND NEW.`actor_user_id` IS NULL)
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

CREATE TRIGGER `message_outbox_content_immutable_update`
BEFORE UPDATE OF
  `id`, `event_id`, `actor_user_id`, `dedupe_key`, `intent`, `recipient_email`, `recipient_name`,
  `template_key`, `template_revision`, `subject`, `text_body`, `content_sha256`, `created_at`
ON `message_outbox`
BEGIN
  SELECT RAISE(ABORT, 'message identity and content are immutable');
END;

CREATE TRIGGER `message_outbox_state_transition_update`
BEFORE UPDATE OF `state` ON `message_outbox`
WHEN NOT (
  (`OLD`.`state` = 'queued' AND `NEW`.`state` = 'leased')
  OR (`OLD`.`state` = 'leased' AND `NEW`.`state` IN ('queued', 'delivered', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'message delivery state transition is invalid');
END;

CREATE TRIGGER `message_outbox_active_delete`
BEFORE DELETE ON `message_outbox`
WHEN `OLD`.`state` NOT IN ('delivered', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'active message delivery cannot be deleted');
END;
