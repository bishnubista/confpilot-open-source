ALTER TABLE `speakers` ADD COLUMN `contact_email` text NOT NULL DEFAULT '';
ALTER TABLE `speakers` ADD COLUMN `workflow_status` text NOT NULL DEFAULT 'invited'
  CHECK (`workflow_status` IN ('invited', 'confirmed', 'declined'));
ALTER TABLE `speakers` ADD COLUMN `social_urls_json` text NOT NULL DEFAULT '{"website":null,"linkedin":null,"x":null}'
  CHECK (json_valid(`social_urls_json`) AND json_type(`social_urls_json`) = 'object');
ALTER TABLE `speakers` ADD COLUMN `travel_preferences` text NOT NULL DEFAULT '';
ALTER TABLE `speakers` ADD COLUMN `headshot_object_key` text;
ALTER TABLE `speakers` ADD COLUMN `headshot_original_filename` text;
ALTER TABLE `speakers` ADD COLUMN `headshot_content_type` text
  CHECK (`headshot_content_type` IS NULL OR `headshot_content_type` IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE `speakers` ADD COLUMN `headshot_byte_size` integer
  CHECK (`headshot_byte_size` IS NULL OR (`headshot_byte_size` > 0 AND `headshot_byte_size` <= 10485760));
ALTER TABLE `speakers` ADD COLUMN `headshot_sha256` text
  CHECK (`headshot_sha256` IS NULL OR (length(`headshot_sha256`) = 64 AND `headshot_sha256` NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE `speakers` ADD COLUMN `headshot_uploaded_at` text;
ALTER TABLE `speakers` ADD COLUMN `revision` integer NOT NULL DEFAULT 1 CHECK (`revision` > 0);
ALTER TABLE `speakers` ADD COLUMN `updated_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z';

UPDATE `speakers`
SET `contact_email` = COALESCE((SELECT `email` FROM `users` WHERE `users`.`id` = `speakers`.`user_id`), ''),
    `workflow_status` = CASE WHEN EXISTS (
      SELECT 1 FROM `session_presenters`
      WHERE `session_presenters`.`event_id` = `speakers`.`event_id`
        AND `session_presenters`.`speaker_id` = `speakers`.`id`
    ) THEN 'confirmed' ELSE 'invited' END;

ALTER TABLE `speaker_tasks` ADD COLUMN `due_at` text;
ALTER TABLE `speaker_tasks` ADD COLUMN `revision` integer NOT NULL DEFAULT 1 CHECK (`revision` > 0);
ALTER TABLE `speaker_tasks` ADD COLUMN `updated_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z';
ALTER TABLE `speaker_tasks` ADD COLUMN `created_by_user_id` text
  REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
UPDATE `speaker_tasks` SET `updated_at` = `created_at`;

ALTER TABLE `program_sessions` ADD COLUMN `revision` integer NOT NULL DEFAULT 1 CHECK (`revision` > 0);

CREATE UNIQUE INDEX `speakers_headshot_object_key_unique`
  ON `speakers` (`headshot_object_key`) WHERE `headshot_object_key` IS NOT NULL;

CREATE TABLE `deliverable_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `request_key` text NOT NULL,
  `request_type` text NOT NULL,
  `label` text NOT NULL,
  `instructions` text NOT NULL,
  `due_at` text NOT NULL,
  `allowed_content_types_json` text NOT NULL,
  `max_bytes` integer NOT NULL,
  `required` integer NOT NULL DEFAULT 1,
  `active` integer NOT NULL DEFAULT 1,
  `revision` integer NOT NULL DEFAULT 1,
  `created_by_user_id` text NOT NULL,
  `updated_by_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`request_key` GLOB '[a-z]*' AND `request_key` NOT GLOB '*[^a-z0-9-]*' AND length(`request_key`) <= 64),
  CHECK (`request_type` = 'presentation'),
  CHECK (`due_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `due_at`)),
  CHECK (json_valid(`allowed_content_types_json`) AND json_type(`allowed_content_types_json`) = 'array'),
  CHECK (`max_bytes` > 0 AND `max_bytes` <= 10485760),
  CHECK (`required` IN (0, 1)),
  CHECK (`active` IN (0, 1)),
  CHECK (`revision` > 0),
  CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`)),
  CHECK (`updated_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`))
);
CREATE UNIQUE INDEX `deliverable_requests_active_key_unique`
  ON `deliverable_requests` (`event_id`, `program_session_id`, `request_key`) WHERE `active` = 1;
CREATE INDEX `deliverable_requests_event_session_index`
  ON `deliverable_requests` (`event_id`, `program_session_id`, `active`, `due_at`);

CREATE TABLE `deliverable_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `request_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `uploaded_by_speaker_id` text NOT NULL,
  `version_number` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `original_filename` text NOT NULL,
  `object_key` text NOT NULL,
  `content_type` text NOT NULL,
  `byte_size` integer NOT NULL,
  `sha256` text NOT NULL,
  `note` text NOT NULL DEFAULT '',
  `uploaded_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`request_id`) REFERENCES `deliverable_requests` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`uploaded_by_speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`version_number` > 0),
  CHECK (length(`idempotency_key`) BETWEEN 8 AND 128),
  CHECK (length(`original_filename`) BETWEEN 1 AND 255),
  CHECK (`content_type` IN (
    'application/pdf', 'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  )),
  CHECK (`byte_size` > 0 AND `byte_size` <= 10485760),
  CHECK (length(`sha256`) = 64 AND `sha256` NOT GLOB '*[^0-9a-f]*'),
  CHECK (`uploaded_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `uploaded_at`))
);
CREATE UNIQUE INDEX `deliverable_versions_request_number_unique`
  ON `deliverable_versions` (`event_id`, `request_id`, `version_number`);
CREATE UNIQUE INDEX `deliverable_versions_request_idempotency_unique`
  ON `deliverable_versions` (`event_id`, `request_id`, `idempotency_key`);
CREATE UNIQUE INDEX `deliverable_versions_object_key_unique`
  ON `deliverable_versions` (`object_key`);
CREATE INDEX `deliverable_versions_event_session_uploaded_index`
  ON `deliverable_versions` (`event_id`, `program_session_id`, `uploaded_at` DESC);

CREATE TABLE `content_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `version_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `outcome` text NOT NULL,
  `comment` text NOT NULL,
  `reviewed_by_user_id` text NOT NULL,
  `reviewed_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`version_id`) REFERENCES `deliverable_versions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`outcome` IN ('changes_requested', 'approved')),
  CHECK (length(`idempotency_key`) BETWEEN 8 AND 128),
  CHECK (length(`comment`) BETWEEN 1 AND 4000),
  CHECK (`reviewed_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `reviewed_at`))
);
CREATE INDEX `content_reviews_event_session_reviewed_index`
  ON `content_reviews` (`event_id`, `program_session_id`, `reviewed_at` DESC);
CREATE INDEX `content_reviews_event_version_reviewed_index`
  ON `content_reviews` (`event_id`, `version_id`, `reviewed_at` DESC);
CREATE UNIQUE INDEX `content_reviews_event_version_idempotency_unique`
  ON `content_reviews` (`event_id`, `version_id`, `idempotency_key`);

CREATE TABLE `content_comments` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `version_id` text NOT NULL,
  `author_user_id` text,
  `author_speaker_id` text,
  `body` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`version_id`) REFERENCES `deliverable_versions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`author_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`author_speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK ((`author_user_id` IS NULL) != (`author_speaker_id` IS NULL)),
  CHECK (length(`body`) BETWEEN 1 AND 4000),
  CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`))
);
CREATE INDEX `content_comments_event_version_created_index`
  ON `content_comments` (`event_id`, `version_id`, `created_at`);

CREATE TABLE `session_content_history` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `action` text NOT NULL,
  `title` text NOT NULL,
  `abstract` text NOT NULL,
  `track` text NOT NULL,
  `format` text NOT NULL,
  `duration_minutes` integer NOT NULL,
  `change_note` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`action` IN ('updated', 'restored')),
  CHECK (`format` IN ('keynote', 'talk', 'lightning', 'workshop', 'panel')),
  CHECK (`duration_minutes` > 0),
  CHECK (length(`change_note`) BETWEEN 1 AND 1000),
  CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`))
);
CREATE INDEX `session_content_history_event_session_created_index`
  ON `session_content_history` (`event_id`, `program_session_id`, `created_at` DESC);

CREATE TABLE `speaker_content_history` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `speaker_id` text NOT NULL,
  `action` text NOT NULL,
  `profile_json` text NOT NULL,
  `change_note` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`action` IN ('updated', 'headshot_uploaded', 'restored')),
  CHECK (json_valid(`profile_json`) AND json_type(`profile_json`) = 'object'),
  CHECK (length(`change_note`) BETWEEN 1 AND 1000),
  CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`))
);
CREATE INDEX `speaker_content_history_event_speaker_created_index`
  ON `speaker_content_history` (`event_id`, `speaker_id`, `created_at` DESC);

CREATE VIEW `session_deliverable_readiness` AS
SELECT session.`event_id`, session.`id` AS `program_session_id`,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM `deliverable_requests` request
      WHERE request.`event_id` = session.`event_id`
        AND request.`program_session_id` = session.`id`
        AND request.`active` = 1 AND request.`required` = 1
        AND NOT EXISTS (
          SELECT 1 FROM `deliverable_versions` version
          WHERE version.`event_id` = request.`event_id` AND version.`request_id` = request.`id`
        )
    ) THEN 'missing'
    WHEN EXISTS (
      SELECT 1 FROM `deliverable_requests` request
      WHERE request.`event_id` = session.`event_id`
        AND request.`program_session_id` = session.`id`
        AND request.`active` = 1 AND request.`required` = 1
        AND NOT EXISTS (
          SELECT 1 FROM `deliverable_versions` version
          WHERE version.`event_id` = request.`event_id` AND version.`request_id` = request.`id`
            AND version.`version_number` = (
              SELECT MAX(latest.`version_number`) FROM `deliverable_versions` latest
              WHERE latest.`event_id` = request.`event_id` AND latest.`request_id` = request.`id`
            )
            AND (
              SELECT review.`outcome` FROM `content_reviews` review
              WHERE review.`event_id` = version.`event_id` AND review.`version_id` = version.`id`
              ORDER BY review.`reviewed_at` DESC, review.`id` DESC LIMIT 1
            ) = 'approved'
        )
    ) THEN 'submitted'
    ELSE 'ready'
  END AS `deliverables_status`
FROM `program_sessions` session;

CREATE TRIGGER `speakers_profile_revision_update`
BEFORE UPDATE OF `name`, `title`, `company`, `bio`, `headshot_url`, `headshot_fallback`,
  `profile_status`, `agreement_status`, `public_visibility`, `contact_email`, `workflow_status`,
  `social_urls_json`, `travel_preferences`, `headshot_object_key`, `headshot_original_filename`,
  `headshot_content_type`, `headshot_byte_size`, `headshot_sha256`, `headshot_uploaded_at` ON `speakers`
BEGIN
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
    THEN RAISE(ABORT, 'speaker profile updates require the next revision and later timestamp') END;
  SELECT CASE WHEN
    (NEW.`headshot_object_key` IS NULL OR NEW.`headshot_original_filename` IS NULL
      OR NEW.`headshot_content_type` IS NULL OR NEW.`headshot_byte_size` IS NULL
      OR NEW.`headshot_sha256` IS NULL OR NEW.`headshot_uploaded_at` IS NULL)
    AND NOT (NEW.`headshot_object_key` IS NULL AND NEW.`headshot_original_filename` IS NULL
      AND NEW.`headshot_content_type` IS NULL AND NEW.`headshot_byte_size` IS NULL
      AND NEW.`headshot_sha256` IS NULL AND NEW.`headshot_uploaded_at` IS NULL)
    THEN RAISE(ABORT, 'headshot metadata must be complete or absent') END;
END;

CREATE TRIGGER `speakers_revision_requires_change`
BEFORE UPDATE OF `revision`, `updated_at` ON `speakers`
WHEN NEW.`name` IS OLD.`name`
  AND NEW.`title` IS OLD.`title`
  AND NEW.`company` IS OLD.`company`
  AND NEW.`bio` IS OLD.`bio`
  AND NEW.`headshot_url` IS OLD.`headshot_url`
  AND NEW.`headshot_fallback` IS OLD.`headshot_fallback`
  AND NEW.`profile_status` IS OLD.`profile_status`
  AND NEW.`agreement_status` IS OLD.`agreement_status`
  AND NEW.`public_visibility` IS OLD.`public_visibility`
  AND NEW.`contact_email` IS OLD.`contact_email`
  AND NEW.`workflow_status` IS OLD.`workflow_status`
  AND NEW.`social_urls_json` IS OLD.`social_urls_json`
  AND NEW.`travel_preferences` IS OLD.`travel_preferences`
  AND NEW.`headshot_object_key` IS OLD.`headshot_object_key`
  AND NEW.`headshot_original_filename` IS OLD.`headshot_original_filename`
  AND NEW.`headshot_content_type` IS OLD.`headshot_content_type`
  AND NEW.`headshot_byte_size` IS OLD.`headshot_byte_size`
  AND NEW.`headshot_sha256` IS OLD.`headshot_sha256`
  AND NEW.`headshot_uploaded_at` IS OLD.`headshot_uploaded_at`
BEGIN
  SELECT RAISE(ABORT, 'speaker revision updates require a profile change');
END;

CREATE TRIGGER `speakers_headshot_object_scope_update`
BEFORE UPDATE OF `event_id`, `headshot_object_key` ON `speakers`
WHEN NEW.`headshot_object_key` IS NOT NULL
BEGIN
  SELECT CASE WHEN substr(NEW.`headshot_object_key`, 1, length('events/' || NEW.`event_id` || '/'))
      != 'events/' || NEW.`event_id` || '/'
    THEN RAISE(ABORT, 'speaker headshot object key must use the same event scope') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `deliverable_versions` WHERE `object_key` = NEW.`headshot_object_key`
  ) THEN RAISE(ABORT, 'private object keys must be globally unique') END;
END;

CREATE TRIGGER `program_sessions_content_revision_update`
BEFORE UPDATE OF `title`, `abstract`, `track`, `format`, `duration_minutes`, `publication_status`,
  `deliverables_status`, `approval_status` ON `program_sessions`
BEGIN
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
    THEN RAISE(ABORT, 'program session updates require the next revision and later timestamp') END;
END;

CREATE TRIGGER `program_sessions_revision_requires_change`
BEFORE UPDATE OF `revision`, `updated_at` ON `program_sessions`
WHEN NEW.`title` IS OLD.`title`
  AND NEW.`abstract` IS OLD.`abstract`
  AND NEW.`track` IS OLD.`track`
  AND NEW.`format` IS OLD.`format`
  AND NEW.`duration_minutes` IS OLD.`duration_minutes`
  AND NEW.`publication_status` IS OLD.`publication_status`
  AND NEW.`deliverables_status` IS OLD.`deliverables_status`
  AND NEW.`approval_status` IS OLD.`approval_status`
BEGIN
  SELECT RAISE(ABORT, 'program session revision updates require a content change');
END;

CREATE TRIGGER `speakers_headshot_metadata_insert`
BEFORE INSERT ON `speakers`
BEGIN
  SELECT CASE WHEN
    (NEW.`headshot_object_key` IS NULL OR NEW.`headshot_original_filename` IS NULL
      OR NEW.`headshot_content_type` IS NULL OR NEW.`headshot_byte_size` IS NULL
      OR NEW.`headshot_sha256` IS NULL OR NEW.`headshot_uploaded_at` IS NULL)
    AND NOT (NEW.`headshot_object_key` IS NULL AND NEW.`headshot_original_filename` IS NULL
      AND NEW.`headshot_content_type` IS NULL AND NEW.`headshot_byte_size` IS NULL
      AND NEW.`headshot_sha256` IS NULL AND NEW.`headshot_uploaded_at` IS NULL)
    THEN RAISE(ABORT, 'headshot metadata must be complete or absent') END;
  SELECT CASE WHEN NEW.`headshot_object_key` IS NOT NULL
      AND substr(NEW.`headshot_object_key`, 1, length('events/' || NEW.`event_id` || '/'))
        != 'events/' || NEW.`event_id` || '/'
    THEN RAISE(ABORT, 'speaker headshot object key must use the same event scope') END;
  SELECT CASE WHEN NEW.`headshot_object_key` IS NOT NULL AND EXISTS (
    SELECT 1 FROM `deliverable_versions` WHERE `object_key` = NEW.`headshot_object_key`
  ) THEN RAISE(ABORT, 'private object keys must be globally unique') END;
END;

CREATE TRIGGER `session_presenters_speaker_workflow_insert`
AFTER INSERT ON `session_presenters`
WHEN EXISTS (
  SELECT 1 FROM `speakers`
  WHERE `id` = NEW.`speaker_id` AND `event_id` = NEW.`event_id`
    AND (`workflow_status` != 'confirmed' OR (
      `contact_email` = '' AND COALESCE((
        SELECT `email` FROM `users` WHERE `users`.`id` = `speakers`.`user_id`
      ), '') != ''
    ))
)
BEGIN
  UPDATE `speakers`
  SET `contact_email` = COALESCE(NULLIF(`contact_email`, ''), (
        SELECT `email` FROM `users` WHERE `users`.`id` = `speakers`.`user_id`
      ), ''),
      `workflow_status` = 'confirmed',
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN julianday(`updated_at`) >= julianday(COALESCE((
          SELECT acceptance.`accepted_at`
          FROM `acceptances` acceptance
          WHERE acceptance.`event_id` = NEW.`event_id`
            AND acceptance.`program_session_id` = NEW.`program_session_id`
        ), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE COALESCE((
          SELECT acceptance.`accepted_at`
          FROM `acceptances` acceptance
          WHERE acceptance.`event_id` = NEW.`event_id`
            AND acceptance.`program_session_id` = NEW.`program_session_id`
        ), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      END
  WHERE `id` = NEW.`speaker_id` AND `event_id` = NEW.`event_id`;
END;

CREATE TRIGGER `speaker_tasks_state_revision_update`
BEFORE UPDATE OF `label`, `state`, `completed_at`, `due_at` ON `speaker_tasks`
BEGIN
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
    THEN RAISE(ABORT, 'speaker task updates require the next revision and later timestamp') END;
  SELECT CASE WHEN (NEW.`state` = 'complete') != (NEW.`completed_at` IS NOT NULL)
    THEN RAISE(ABORT, 'speaker task completion timestamp must match state') END;
END;

CREATE TRIGGER `speaker_tasks_revision_requires_change`
BEFORE UPDATE OF `revision`, `updated_at` ON `speaker_tasks`
WHEN NEW.`label` IS OLD.`label`
  AND NEW.`state` IS OLD.`state`
  AND NEW.`completed_at` IS OLD.`completed_at`
  AND NEW.`due_at` IS OLD.`due_at`
BEGIN
  SELECT RAISE(ABORT, 'speaker task revision updates require a task change');
END;

CREATE TRIGGER `speaker_tasks_provenance_insert`
BEFORE INSERT ON `speaker_tasks`
BEGIN
  SELECT CASE WHEN NEW.`created_by_user_id` IS NULL AND NOT (
      (NEW.`id` LIKE 'task:presenter-%' OR NEW.`id` LIKE 'task:session-presenter:%')
      AND NEW.`task_key` IN ('confirm', 'profile', 'release', 'headshot')
    ) THEN RAISE(ABORT, 'custom speaker task must identify its creating organizer') END;
  SELECT CASE WHEN NEW.`created_by_user_id` IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
    ) THEN RAISE(ABORT, 'speaker task must be created by a same-event organizer') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `acceptances` acceptance
    INNER JOIN `session_presenters` presenter
      ON presenter.`event_id` = acceptance.`event_id`
      AND presenter.`program_session_id` = acceptance.`program_session_id`
    WHERE acceptance.`id` = NEW.`acceptance_id`
      AND acceptance.`event_id` = NEW.`event_id`
      AND acceptance.`program_session_id` = NEW.`program_session_id`
      AND presenter.`speaker_id` = NEW.`speaker_id`
  ) THEN RAISE(ABORT, 'speaker task must target an accepted presenter in the same event') END;
END;

CREATE TRIGGER `deliverable_requests_valid_insert`
BEFORE INSERT ON `deliverable_requests`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `program_sessions`
    WHERE `id` = NEW.`program_session_id` AND `event_id` = NEW.`event_id`
  ) THEN RAISE(ABORT, 'deliverable request session must belong to the same event') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
  ) OR NEW.`updated_by_user_id` != NEW.`created_by_user_id`
    THEN RAISE(ABORT, 'deliverable request must be created by a same-event organizer') END;
  SELECT CASE WHEN NEW.`revision` != 1 OR NEW.`created_at` != NEW.`updated_at`
    THEN RAISE(ABORT, 'deliverable request must start at revision one') END;
  SELECT CASE WHEN json_array_length(NEW.`allowed_content_types_json`) < 1
    OR json_array_length(NEW.`allowed_content_types_json`) > 3
    OR (SELECT COUNT(*) FROM json_each(NEW.`allowed_content_types_json`)) !=
      (SELECT COUNT(DISTINCT value) FROM json_each(NEW.`allowed_content_types_json`))
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`allowed_content_types_json`) item
      WHERE item.value NOT IN (
        'application/pdf', 'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    ) THEN RAISE(ABORT, 'deliverable request content types must match request type') END;
END;

CREATE TRIGGER `deliverable_requests_identity_immutable_update`
BEFORE UPDATE OF `id`, `event_id`, `program_session_id`, `request_key`, `request_type`, `created_by_user_id`, `created_at`
ON `deliverable_requests`
BEGIN
  SELECT RAISE(ABORT, 'deliverable request identity is immutable');
END;

CREATE TRIGGER `deliverable_requests_immutable_delete`
BEFORE DELETE ON `deliverable_requests`
BEGIN
  SELECT RAISE(ABORT, 'deliverable requests are immutable; deactivate the request instead');
END;

CREATE TRIGGER `deliverable_requests_valid_update`
BEFORE UPDATE ON `deliverable_requests`
BEGIN
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
    THEN RAISE(ABORT, 'deliverable request updates require the next revision and later timestamp') END;
  SELECT CASE WHEN NEW.`id` IS OLD.`id`
      AND NEW.`event_id` IS OLD.`event_id`
      AND NEW.`program_session_id` IS OLD.`program_session_id`
      AND NEW.`request_key` IS OLD.`request_key`
      AND NEW.`request_type` IS OLD.`request_type`
      AND NEW.`created_by_user_id` IS OLD.`created_by_user_id`
      AND NEW.`created_at` IS OLD.`created_at`
      AND NEW.`label` IS OLD.`label`
      AND NEW.`instructions` IS OLD.`instructions`
      AND NEW.`due_at` IS OLD.`due_at`
      AND NEW.`allowed_content_types_json` IS OLD.`allowed_content_types_json`
      AND NEW.`max_bytes` IS OLD.`max_bytes`
      AND NEW.`required` IS OLD.`required`
      AND NEW.`active` IS OLD.`active`
    THEN RAISE(ABORT, 'deliverable request revisions require a request change') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`updated_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'deliverable request must be updated by a same-event organizer') END;
  SELECT CASE WHEN json_array_length(NEW.`allowed_content_types_json`) < 1
    OR json_array_length(NEW.`allowed_content_types_json`) > 3
    OR (SELECT COUNT(*) FROM json_each(NEW.`allowed_content_types_json`)) !=
      (SELECT COUNT(DISTINCT value) FROM json_each(NEW.`allowed_content_types_json`))
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`allowed_content_types_json`) item
      WHERE item.value NOT IN (
        'application/pdf', 'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    ) THEN RAISE(ABORT, 'deliverable request content types must match request type') END;
END;

CREATE TRIGGER `deliverable_versions_valid_insert`
BEFORE INSERT ON `deliverable_versions`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `deliverable_requests` request
    WHERE request.`id` = NEW.`request_id` AND request.`event_id` = NEW.`event_id`
      AND request.`program_session_id` = NEW.`program_session_id` AND request.`active` = 1
  ) THEN RAISE(ABORT, 'deliverable version must belong to an active request in the same event and session') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `session_presenters`
    WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      AND `speaker_id` = NEW.`uploaded_by_speaker_id`
  ) THEN RAISE(ABORT, 'deliverable version uploader must be an accepted session presenter') END;
  SELECT CASE WHEN NEW.`version_number` != COALESCE((
    SELECT MAX(`version_number`) + 1 FROM `deliverable_versions`
    WHERE `event_id` = NEW.`event_id` AND `request_id` = NEW.`request_id`
  ), 1) THEN RAISE(ABORT, 'deliverable version must use the next contiguous version number') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `deliverable_requests` request, json_each(request.`allowed_content_types_json`) item
    WHERE request.`id` = NEW.`request_id` AND request.`event_id` = NEW.`event_id`
      AND item.value = NEW.`content_type` AND NEW.`byte_size` <= request.`max_bytes`
  ) THEN RAISE(ABORT, 'deliverable version type and size must match its request') END;
  SELECT CASE WHEN substr(NEW.`object_key`, 1, length('events/' || NEW.`event_id` || '/'))
      != 'events/' || NEW.`event_id` || '/'
    THEN RAISE(ABORT, 'deliverable object key must use the same event scope') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `speakers` WHERE `headshot_object_key` = NEW.`object_key`
  ) THEN RAISE(ABORT, 'private object keys must be globally unique') END;
END;

CREATE TRIGGER `deliverable_versions_immutable_update`
BEFORE UPDATE ON `deliverable_versions`
BEGIN
  SELECT RAISE(ABORT, 'deliverable versions are immutable');
END;
CREATE TRIGGER `deliverable_versions_immutable_delete`
BEFORE DELETE ON `deliverable_versions`
BEGIN
  SELECT RAISE(ABORT, 'deliverable versions are immutable');
END;

CREATE TRIGGER `content_reviews_valid_insert`
BEFORE INSERT ON `content_reviews`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `deliverable_versions`
    WHERE `id` = NEW.`version_id` AND `event_id` = NEW.`event_id`
      AND `program_session_id` = NEW.`program_session_id`
  ) THEN RAISE(ABORT, 'content review version must belong to the same event and session') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`reviewed_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'content review must be recorded by a same-event organizer') END;
END;
CREATE TRIGGER `content_reviews_chronological_insert`
BEFORE INSERT ON `content_reviews`
WHEN EXISTS (
  SELECT 1 FROM `content_reviews`
  WHERE `event_id` = NEW.`event_id` AND `version_id` = NEW.`version_id`
)
BEGIN
  SELECT CASE WHEN NEW.`reviewed_at` <= (
    SELECT MAX(`reviewed_at`) FROM `content_reviews`
    WHERE `event_id` = NEW.`event_id` AND `version_id` = NEW.`version_id`
  ) THEN RAISE(ABORT, 'content review timestamp must follow the prior version review') END;
END;
CREATE TRIGGER `content_reviews_immutable_update`
BEFORE UPDATE ON `content_reviews`
BEGIN
  SELECT RAISE(ABORT, 'content reviews are immutable');
END;
CREATE TRIGGER `content_reviews_immutable_delete`
BEFORE DELETE ON `content_reviews`
BEGIN
  SELECT RAISE(ABORT, 'content reviews are immutable');
END;

CREATE TRIGGER `content_comments_valid_insert`
BEFORE INSERT ON `content_comments`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `deliverable_versions`
    WHERE `id` = NEW.`version_id` AND `event_id` = NEW.`event_id`
      AND `program_session_id` = NEW.`program_session_id`
  ) THEN RAISE(ABORT, 'content comment version must belong to the same event and session') END;
  SELECT CASE WHEN NEW.`author_speaker_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `session_presenters`
    WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      AND `speaker_id` = NEW.`author_speaker_id`
  ) THEN RAISE(ABORT, 'content comment speaker must be a same-event session presenter') END;
  SELECT CASE WHEN NEW.`author_user_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`author_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'content comment user must be a same-event organizer') END;
END;
CREATE TRIGGER `content_comments_immutable_update`
BEFORE UPDATE ON `content_comments`
BEGIN
  SELECT RAISE(ABORT, 'content comments are immutable');
END;
CREATE TRIGGER `content_comments_immutable_delete`
BEFORE DELETE ON `content_comments`
BEGIN
  SELECT RAISE(ABORT, 'content comments are immutable');
END;

CREATE TRIGGER `session_content_history_valid_insert`
BEFORE INSERT ON `session_content_history`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `program_sessions`
    WHERE `id` = NEW.`program_session_id` AND `event_id` = NEW.`event_id`
  ) THEN RAISE(ABORT, 'session content history must belong to the same event') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`actor_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'session content history actor must be a same-event organizer') END;
END;
CREATE TRIGGER `session_content_history_immutable_update`
BEFORE UPDATE ON `session_content_history`
BEGIN
  SELECT RAISE(ABORT, 'session content history is immutable');
END;
CREATE TRIGGER `session_content_history_immutable_delete`
BEFORE DELETE ON `session_content_history`
BEGIN
  SELECT RAISE(ABORT, 'session content history is immutable');
END;

CREATE TRIGGER `speaker_content_history_valid_insert`
BEFORE INSERT ON `speaker_content_history`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `speakers` WHERE `id` = NEW.`speaker_id` AND `event_id` = NEW.`event_id`
  ) THEN RAISE(ABORT, 'speaker content history must belong to the same event') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`actor_user_id` AND `role` = 'organizer'
  ) AND NOT (
    NEW.`action` = 'updated' AND EXISTS (
      SELECT 1 FROM `speakers`
      WHERE `id` = NEW.`speaker_id` AND `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`actor_user_id`
    )
  ) THEN RAISE(ABORT, 'speaker content history actor must be a same-event organizer or target speaker') END;
END;
CREATE TRIGGER `speaker_content_history_immutable_update`
BEFORE UPDATE ON `speaker_content_history`
BEGIN
  SELECT RAISE(ABORT, 'speaker content history is immutable');
END;
CREATE TRIGGER `speaker_content_history_immutable_delete`
BEFORE DELETE ON `speaker_content_history`
BEGIN
  SELECT RAISE(ABORT, 'speaker content history is immutable');
END;

CREATE TRIGGER `program_sessions_approval_gate_update`
BEFORE UPDATE OF `approval_status` ON `program_sessions`
WHEN OLD.`approval_status` != 'approved' AND NEW.`approval_status` = 'approved'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `deliverable_requests` request
    WHERE request.`event_id` = NEW.`event_id` AND request.`program_session_id` = NEW.`id`
      AND request.`active` = 1 AND request.`required` = 1
      AND NOT EXISTS (
        SELECT 1 FROM `deliverable_versions` version
        WHERE version.`event_id` = request.`event_id` AND version.`request_id` = request.`id`
          AND version.`version_number` = (
            SELECT MAX(latest.`version_number`) FROM `deliverable_versions` latest
            WHERE latest.`event_id` = request.`event_id` AND latest.`request_id` = request.`id`
          )
          AND (
            SELECT review.`outcome` FROM `content_reviews` review
            WHERE review.`event_id` = version.`event_id` AND review.`version_id` = version.`id`
            ORDER BY review.`reviewed_at` DESC, review.`id` DESC LIMIT 1
          ) = 'approved'
      )
  ) THEN RAISE(ABORT, 'session approval requires approved latest required deliverables') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `speaker_tasks`
    WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`id` AND `state` = 'open'
  ) THEN RAISE(ABORT, 'session approval requires all presenter tasks complete or waived') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `session_presenters` presenter
    INNER JOIN `speakers` speaker ON speaker.`id` = presenter.`speaker_id` AND speaker.`event_id` = presenter.`event_id`
    WHERE presenter.`event_id` = NEW.`event_id` AND presenter.`program_session_id` = NEW.`id`
      AND (
        speaker.`workflow_status` != 'confirmed'
        OR speaker.`profile_status` != 'ready'
        OR speaker.`agreement_status` != 'signed'
      )
  ) THEN RAISE(ABORT, 'session approval requires ready signed presenter profiles') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `session_presenters` presenter
    INNER JOIN `speakers` speaker ON speaker.`id` = presenter.`speaker_id` AND speaker.`event_id` = presenter.`event_id`
    WHERE presenter.`event_id` = NEW.`event_id` AND presenter.`program_session_id` = NEW.`id`
      AND presenter.`role` = 'primary' AND speaker.`public_visibility` = 'published'
  ) THEN RAISE(ABORT, 'session approval requires a published primary speaker') END;
END;

CREATE TRIGGER `deliverable_requests_demote_approved_insert`
AFTER INSERT ON `deliverable_requests`
BEGIN
  UPDATE `program_sessions`
  SET `deliverables_status` = (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      ),
      `approval_status` = CASE
        WHEN `approval_status` = 'approved' AND NEW.`active` = 1 AND NEW.`required` = 1
          THEN 'pending'
        ELSE `approval_status`
      END,
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `id` = NEW.`program_session_id`
    AND `event_id` = NEW.`event_id`
    AND (
      `deliverables_status` != (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      )
      OR (`approval_status` = 'approved' AND NEW.`active` = 1 AND NEW.`required` = 1)
    );
END;

CREATE TRIGGER `deliverable_requests_demote_approved_update`
AFTER UPDATE ON `deliverable_requests`
BEGIN
  UPDATE `program_sessions`
  SET `deliverables_status` = (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      ),
      `approval_status` = CASE
        WHEN `approval_status` = 'approved' AND NEW.`active` = 1 AND NEW.`required` = 1
          THEN 'pending'
        ELSE `approval_status`
      END,
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `id` = NEW.`program_session_id`
    AND `event_id` = NEW.`event_id`
    AND (
      `deliverables_status` != (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      )
      OR (`approval_status` = 'approved' AND NEW.`active` = 1 AND NEW.`required` = 1)
    );
END;

CREATE TRIGGER `deliverable_versions_demote_approved_insert`
AFTER INSERT ON `deliverable_versions`
BEGIN
  UPDATE `program_sessions`
  SET `deliverables_status` = (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      ),
      `approval_status` = CASE WHEN `approval_status` = 'approved' THEN 'pending' ELSE `approval_status` END,
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `id` = NEW.`program_session_id`
    AND `event_id` = NEW.`event_id`
    AND (
      `deliverables_status` != (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      )
      OR `approval_status` = 'approved'
    );
END;

CREATE TRIGGER `content_reviews_demote_approved_insert`
AFTER INSERT ON `content_reviews`
BEGIN
  UPDATE `program_sessions`
  SET `deliverables_status` = (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      ),
      `approval_status` = CASE
        WHEN `approval_status` = 'approved' AND NEW.`outcome` = 'changes_requested'
          AND NEW.`id` = (
            SELECT review.`id` FROM `content_reviews` review
            WHERE review.`event_id` = NEW.`event_id` AND review.`version_id` = NEW.`version_id`
            ORDER BY review.`reviewed_at` DESC, review.`id` DESC LIMIT 1
          ) THEN 'pending'
        ELSE `approval_status`
      END,
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `id` = NEW.`program_session_id`
    AND `event_id` = NEW.`event_id`
    AND (
      `deliverables_status` != (
        SELECT `deliverables_status` FROM `session_deliverable_readiness`
        WHERE `event_id` = NEW.`event_id` AND `program_session_id` = NEW.`program_session_id`
      )
      OR (`approval_status` = 'approved' AND NEW.`outcome` = 'changes_requested'
        AND NEW.`id` = (
          SELECT review.`id` FROM `content_reviews` review
          WHERE review.`event_id` = NEW.`event_id` AND review.`version_id` = NEW.`version_id`
          ORDER BY review.`reviewed_at` DESC, review.`id` DESC LIMIT 1
        ))
    );
END;

CREATE TRIGGER `speaker_tasks_demote_approved_insert`
AFTER INSERT ON `speaker_tasks`
WHEN NEW.`state` = 'open'
BEGIN
  UPDATE `program_sessions`
  SET `approval_status` = 'pending',
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `id` = NEW.`program_session_id`
    AND `event_id` = NEW.`event_id`
    AND `approval_status` = 'approved';
END;

CREATE TRIGGER `speaker_tasks_demote_approved_update`
AFTER UPDATE OF `state` ON `speaker_tasks`
WHEN OLD.`state` != 'open' AND NEW.`state` = 'open'
BEGIN
  UPDATE `program_sessions`
  SET `approval_status` = 'pending',
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `id` = NEW.`program_session_id`
    AND `event_id` = NEW.`event_id`
    AND `approval_status` = 'approved';
END;

CREATE TRIGGER `speakers_demote_approved_update`
AFTER UPDATE OF `workflow_status`, `profile_status`, `agreement_status`, `public_visibility`
ON `speakers`
WHEN (OLD.`workflow_status` = 'confirmed' AND NEW.`workflow_status` != 'confirmed')
  OR (OLD.`profile_status` = 'ready' AND NEW.`profile_status` != 'ready')
  OR (OLD.`agreement_status` = 'signed' AND NEW.`agreement_status` != 'signed')
  OR (OLD.`public_visibility` = 'published' AND NEW.`public_visibility` != 'published')
BEGIN
  UPDATE `program_sessions`
  SET `approval_status` = 'pending',
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `event_id` = NEW.`event_id`
    AND `approval_status` = 'approved'
    AND EXISTS (
      SELECT 1 FROM `session_presenters` presenter
      WHERE presenter.`event_id` = NEW.`event_id`
        AND presenter.`program_session_id` = `program_sessions`.`id`
        AND presenter.`speaker_id` = NEW.`id`
        AND (
          NEW.`workflow_status` != 'confirmed'
          OR NEW.`profile_status` != 'ready'
          OR NEW.`agreement_status` != 'signed'
          OR (
            presenter.`role` = 'primary'
            AND NOT EXISTS (
              SELECT 1 FROM `session_presenters` primary_presenter
              INNER JOIN `speakers` primary_speaker
                ON primary_speaker.`id` = primary_presenter.`speaker_id`
                AND primary_speaker.`event_id` = primary_presenter.`event_id`
              WHERE primary_presenter.`event_id` = NEW.`event_id`
                AND primary_presenter.`program_session_id` = presenter.`program_session_id`
                AND primary_presenter.`role` = 'primary'
                AND primary_speaker.`public_visibility` = 'published'
            )
          )
        )
    );
END;
