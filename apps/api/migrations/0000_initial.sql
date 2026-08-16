CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `display_name` text NOT NULL,
  `created_at` text NOT NULL
);
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);

CREATE TABLE `auth_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `token_hash` text NOT NULL,
  `expires_at` text NOT NULL,
  `revoked_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);

CREATE TABLE `events` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `tagline` text NOT NULL,
  `location` text NOT NULL,
  `description` text NOT NULL,
  `starts_on` text NOT NULL,
  `ends_on` text NOT NULL,
  `cfp_deadline` text NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  CHECK (`status` IN ('draft', 'open', 'scheduled', 'published')),
  CHECK (`starts_on` <= `ends_on`)
);
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);

CREATE TABLE `event_memberships` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `user_id` text NOT NULL,
  `role` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`role` IN ('organizer', 'reviewer', 'speaker'))
);
CREATE UNIQUE INDEX `event_memberships_event_user_unique` ON `event_memberships` (`event_id`, `user_id`);

CREATE TABLE `event_days` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `day_number` integer NOT NULL,
  `date` text NOT NULL,
  `label` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`day_number` > 0)
);
CREATE UNIQUE INDEX `event_days_event_number_unique` ON `event_days` (`event_id`, `day_number`);
CREATE UNIQUE INDEX `event_days_event_date_unique` ON `event_days` (`event_id`, `date`);

CREATE TABLE `rooms` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `name` text NOT NULL,
  `capacity` integer NOT NULL,
  `sort_order` integer NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`capacity` > 0)
);
CREATE UNIQUE INDEX `rooms_event_name_unique` ON `rooms` (`event_id`, `name`);

CREATE TABLE `speakers` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `user_id` text,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `title` text NOT NULL,
  `company` text NOT NULL,
  `bio` text NOT NULL,
  `headshot_url` text,
  `headshot_fallback` text NOT NULL,
  `profile_status` text DEFAULT 'incomplete' NOT NULL,
  `agreement_status` text DEFAULT 'missing' NOT NULL,
  `public_visibility` text DEFAULT 'private' NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE set null,
  CHECK (`profile_status` IN ('incomplete', 'ready')),
  CHECK (`agreement_status` IN ('missing', 'signed')),
  CHECK (`public_visibility` IN ('private', 'published'))
);
CREATE UNIQUE INDEX `speakers_event_name_unique` ON `speakers` (`event_id`, `name`);
CREATE UNIQUE INDEX `speakers_event_slug_unique` ON `speakers` (`event_id`, `slug`);
CREATE UNIQUE INDEX `speakers_event_user_unique` ON `speakers` (`event_id`, `user_id`);

CREATE TABLE `proposals` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `public_id` text NOT NULL,
  `slug` text NOT NULL,
  `title` text NOT NULL,
  `abstract` text NOT NULL,
  `track` text NOT NULL,
  `format` text NOT NULL,
  `duration_minutes` integer NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `submitted_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`format` IN ('keynote', 'talk', 'lightning', 'workshop', 'panel')),
  CHECK (`duration_minutes` > 0),
  CHECK (`status` IN ('draft', 'submitted', 'in_review', 'decided')),
  CHECK ((`status` = 'draft' AND `submitted_at` IS NULL) OR (`status` != 'draft' AND `submitted_at` IS NOT NULL))
);
CREATE UNIQUE INDEX `proposals_event_public_id_unique` ON `proposals` (`event_id`, `public_id`);
CREATE UNIQUE INDEX `proposals_event_slug_unique` ON `proposals` (`event_id`, `slug`);

CREATE TABLE `proposal_presenters` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `proposal_id` text NOT NULL,
  `speaker_id` text NOT NULL,
  `role` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`proposal_id`) REFERENCES `proposals` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`role` IN ('primary', 'co_presenter'))
);
CREATE UNIQUE INDEX `proposal_presenters_event_proposal_speaker_unique` ON `proposal_presenters` (`event_id`, `proposal_id`, `speaker_id`);
CREATE UNIQUE INDEX `proposal_presenters_one_primary_unique` ON `proposal_presenters` (`event_id`, `proposal_id`) WHERE `role` = 'primary';

CREATE TABLE `decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `proposal_id` text NOT NULL,
  `decision` text NOT NULL,
  `rationale` text NOT NULL,
  `decided_by_user_id` text NOT NULL,
  `decided_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`proposal_id`) REFERENCES `proposals` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`decided_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`decision` IN ('accept', 'reject', 'waitlist'))
);
CREATE UNIQUE INDEX `decisions_event_proposal_unique` ON `decisions` (`event_id`, `proposal_id`);

CREATE TABLE `program_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `source_proposal_id` text NOT NULL,
  `slug` text NOT NULL,
  `title` text NOT NULL,
  `abstract` text NOT NULL,
  `track` text NOT NULL,
  `format` text NOT NULL,
  `duration_minutes` integer NOT NULL,
  `publication_status` text DEFAULT 'private' NOT NULL,
  `deliverables_status` text DEFAULT 'missing' NOT NULL,
  `approval_status` text DEFAULT 'pending' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`source_proposal_id`) REFERENCES `proposals` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`format` IN ('keynote', 'talk', 'lightning', 'workshop', 'panel')),
  CHECK (`duration_minutes` > 0),
  CHECK (`publication_status` IN ('private', 'ready', 'published')),
  CHECK (`deliverables_status` IN ('missing', 'submitted', 'ready')),
  CHECK (`approval_status` IN ('pending', 'changes_requested', 'approved'))
);
CREATE UNIQUE INDEX `program_sessions_event_slug_unique` ON `program_sessions` (`event_id`, `slug`);
CREATE UNIQUE INDEX `program_sessions_event_source_proposal_unique` ON `program_sessions` (`event_id`, `source_proposal_id`);

CREATE TABLE `acceptances` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `proposal_id` text NOT NULL,
  `decision_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `accepted_by_user_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `accepted_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`proposal_id`) REFERENCES `proposals` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`decision_id`) REFERENCES `decisions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`accepted_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict
);
CREATE UNIQUE INDEX `acceptances_event_proposal_unique` ON `acceptances` (`event_id`, `proposal_id`);
CREATE UNIQUE INDEX `acceptances_event_decision_unique` ON `acceptances` (`event_id`, `decision_id`);
CREATE UNIQUE INDEX `acceptances_event_program_session_unique` ON `acceptances` (`event_id`, `program_session_id`);
CREATE UNIQUE INDEX `acceptances_event_idempotency_key_unique` ON `acceptances` (`event_id`, `idempotency_key`);

CREATE TABLE `session_presenters` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `speaker_id` text NOT NULL,
  `role` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`role` IN ('primary', 'co_presenter'))
);
CREATE UNIQUE INDEX `session_presenters_event_session_speaker_unique` ON `session_presenters` (`event_id`, `program_session_id`, `speaker_id`);
CREATE UNIQUE INDEX `session_presenters_one_primary_unique` ON `session_presenters` (`event_id`, `program_session_id`) WHERE `role` = 'primary';

CREATE TABLE `speaker_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `acceptance_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `speaker_id` text NOT NULL,
  `task_key` text NOT NULL,
  `label` text NOT NULL,
  `state` text DEFAULT 'open' NOT NULL,
  `created_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`acceptance_id`) REFERENCES `acceptances` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`state` IN ('open', 'complete', 'waived')),
  CHECK ((`state` = 'complete' AND `completed_at` IS NOT NULL) OR (`state` != 'complete' AND `completed_at` IS NULL))
);
CREATE UNIQUE INDEX `speaker_tasks_event_session_speaker_key_unique` ON `speaker_tasks` (`event_id`, `program_session_id`, `speaker_id`, `task_key`);

CREATE TABLE `notification_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `acceptance_id` text NOT NULL,
  `decision_id` text NOT NULL,
  `recipient_speaker_id` text NOT NULL,
  `subject` text NOT NULL,
  `state` text DEFAULT 'pending' NOT NULL,
  `queued_at` text NOT NULL,
  `sent_at` text,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`acceptance_id`) REFERENCES `acceptances` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`decision_id`) REFERENCES `decisions` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`recipient_speaker_id`) REFERENCES `speakers` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`state` IN ('pending', 'sent', 'failed')),
  CHECK ((`state` = 'sent' AND `sent_at` IS NOT NULL) OR (`state` != 'sent' AND `sent_at` IS NULL))
);
CREATE UNIQUE INDEX `notification_outbox_acceptance_recipient_unique` ON `notification_outbox` (`event_id`, `acceptance_id`, `recipient_speaker_id`);

CREATE TABLE `schedule_placements` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `program_session_id` text NOT NULL,
  `event_day_id` text NOT NULL,
  `room_id` text NOT NULL,
  `starts_at` text NOT NULL,
  `ends_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`program_session_id`) REFERENCES `program_sessions` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`event_day_id`) REFERENCES `event_days` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`room_id`) REFERENCES `rooms` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (`starts_at` < `ends_at`),
  CHECK (`starts_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `starts_at`)),
  CHECK (`ends_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `ends_at`))
);
CREATE UNIQUE INDEX `placements_event_session_unique` ON `schedule_placements` (`event_id`, `program_session_id`);
CREATE UNIQUE INDEX `placements_event_room_start_unique` ON `schedule_placements` (`event_id`, `room_id`, `starts_at`);

CREATE TRIGGER `proposal_presenters_same_event_insert`
BEFORE INSERT ON `proposal_presenters`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) != NEW.`event_id`
    OR (SELECT `event_id` FROM `speakers` WHERE `id` = NEW.`speaker_id`) != NEW.`event_id`
    OR EXISTS (
      SELECT 1 FROM `acceptances`
      WHERE `event_id` = NEW.`event_id` AND `proposal_id` = NEW.`proposal_id`
    )
  THEN RAISE(ABORT, 'proposal presenters must be event-scoped and are immutable after acceptance') END;
END;

CREATE TRIGGER `proposal_presenters_same_event_update`
BEFORE UPDATE ON `proposal_presenters`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) != NEW.`event_id`
    OR (SELECT `event_id` FROM `speakers` WHERE `id` = NEW.`speaker_id`) != NEW.`event_id`
    OR EXISTS (
      SELECT 1 FROM `acceptances`
      WHERE `event_id` = OLD.`event_id` AND `proposal_id` = OLD.`proposal_id`
    )
  THEN RAISE(ABORT, 'accepted proposal presenters are immutable and event-scoped') END;
END;

CREATE TRIGGER `proposal_presenters_locked_after_acceptance_delete`
BEFORE DELETE ON `proposal_presenters`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `acceptances`
    WHERE `event_id` = OLD.`event_id` AND `proposal_id` = OLD.`proposal_id`
  ) THEN RAISE(ABORT, 'accepted proposal presenters are immutable') END;
END;

CREATE TRIGGER `decisions_scope_insert`
BEFORE INSERT ON `decisions`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) != NEW.`event_id`
    OR NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`decided_by_user_id`
        AND `role` = 'organizer'
    )
  THEN RAISE(ABORT, 'decision must be event-scoped and recorded by an organizer') END;
END;

CREATE TRIGGER `decisions_immutable_update`
BEFORE UPDATE ON `decisions`
BEGIN
  SELECT RAISE(ABORT, 'decisions are immutable');
END;

CREATE TRIGGER `decisions_immutable_delete`
BEFORE DELETE ON `decisions`
BEGIN
  SELECT RAISE(ABORT, 'decisions are immutable');
END;

CREATE TRIGGER `program_sessions_same_event_insert`
BEFORE INSERT ON `program_sessions`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`source_proposal_id`) != NEW.`event_id`
  THEN RAISE(ABORT, 'program session proposal must belong to the same event') END;
END;

CREATE TRIGGER `program_sessions_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `source_proposal_id` ON `program_sessions`
BEGIN
  SELECT RAISE(ABORT, 'program session event and source proposal are immutable');
END;

CREATE TRIGGER `acceptances_valid_chain_insert`
BEFORE INSERT ON `acceptances`
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (
      SELECT 1 FROM `decisions`
      WHERE `id` = NEW.`decision_id`
        AND `event_id` = NEW.`event_id`
        AND `proposal_id` = NEW.`proposal_id`
        AND `decision` = 'accept'
    )
    OR NOT EXISTS (
      SELECT 1 FROM `program_sessions`
      WHERE `id` = NEW.`program_session_id`
        AND `event_id` = NEW.`event_id`
        AND `source_proposal_id` = NEW.`proposal_id`
    )
    OR NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id`
        AND `user_id` = NEW.`accepted_by_user_id`
        AND `role` = 'organizer'
    )
    OR (
      SELECT COUNT(*) FROM `proposal_presenters`
      WHERE `event_id` = NEW.`event_id`
        AND `proposal_id` = NEW.`proposal_id`
        AND `role` = 'primary'
    ) != 1
  THEN RAISE(ABORT, 'acceptance must connect one accepted event-scoped proposal and session') END;
END;

CREATE TRIGGER `acceptances_immutable_update`
BEFORE UPDATE ON `acceptances`
BEGIN
  SELECT RAISE(ABORT, 'acceptances are immutable');
END;

CREATE TRIGGER `acceptances_immutable_delete`
BEFORE DELETE ON `acceptances`
BEGIN
  SELECT RAISE(ABORT, 'acceptances are immutable');
END;

CREATE TRIGGER `session_presenters_valid_chain_insert`
BEFORE INSERT ON `session_presenters`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `program_sessions` WHERE `id` = NEW.`program_session_id`) != NEW.`event_id`
    OR (SELECT `event_id` FROM `speakers` WHERE `id` = NEW.`speaker_id`) != NEW.`event_id`
    OR NOT EXISTS (
      SELECT 1
      FROM `program_sessions` session
      INNER JOIN `proposal_presenters` presenter
        ON presenter.`proposal_id` = session.`source_proposal_id`
        AND presenter.`event_id` = session.`event_id`
      WHERE session.`id` = NEW.`program_session_id`
        AND presenter.`speaker_id` = NEW.`speaker_id`
        AND presenter.`role` = NEW.`role`
    )
  THEN RAISE(ABORT, 'session presenter must preserve the accepted proposal presenter') END;
END;

CREATE TRIGGER `session_presenters_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `program_session_id`, `speaker_id`, `role` ON `session_presenters`
BEGIN
  SELECT RAISE(ABORT, 'accepted session presenters are immutable');
END;

CREATE TRIGGER `speaker_tasks_valid_chain_insert`
BEFORE INSERT ON `speaker_tasks`
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (
      SELECT 1 FROM `acceptances`
      WHERE `id` = NEW.`acceptance_id`
        AND `event_id` = NEW.`event_id`
        AND `program_session_id` = NEW.`program_session_id`
    )
    OR NOT EXISTS (
      SELECT 1 FROM `session_presenters`
      WHERE `event_id` = NEW.`event_id`
        AND `program_session_id` = NEW.`program_session_id`
        AND `speaker_id` = NEW.`speaker_id`
    )
  THEN RAISE(ABORT, 'speaker task must belong to an accepted session presenter') END;
END;

CREATE TRIGGER `speaker_tasks_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `acceptance_id`, `program_session_id`, `speaker_id`, `task_key` ON `speaker_tasks`
BEGIN
  SELECT RAISE(ABORT, 'speaker task ownership is immutable');
END;

CREATE TRIGGER `notification_outbox_valid_chain_insert`
BEFORE INSERT ON `notification_outbox`
BEGIN
  SELECT CASE WHEN
    NOT EXISTS (
      SELECT 1 FROM `acceptances`
      WHERE `id` = NEW.`acceptance_id`
        AND `event_id` = NEW.`event_id`
        AND `decision_id` = NEW.`decision_id`
    )
    OR NOT EXISTS (
      SELECT 1
      FROM `acceptances` acceptance
      INNER JOIN `session_presenters` presenter
        ON presenter.`program_session_id` = acceptance.`program_session_id`
        AND presenter.`event_id` = acceptance.`event_id`
      WHERE acceptance.`id` = NEW.`acceptance_id`
        AND presenter.`speaker_id` = NEW.`recipient_speaker_id`
        AND presenter.`role` = 'primary'
    )
  THEN RAISE(ABORT, 'notification must target the accepted proposal primary speaker') END;
END;

CREATE TRIGGER `notification_outbox_identity_immutable_update`
BEFORE UPDATE OF `event_id`, `acceptance_id`, `decision_id`, `recipient_speaker_id` ON `notification_outbox`
BEGIN
  SELECT RAISE(ABORT, 'notification ownership is immutable');
END;

CREATE TRIGGER `placements_same_event_insert`
BEFORE INSERT ON `schedule_placements`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `program_sessions` WHERE `id` = NEW.`program_session_id`) != NEW.`event_id`
    OR (SELECT `event_id` FROM `event_days` WHERE `id` = NEW.`event_day_id`) != NEW.`event_id`
    OR (SELECT `event_id` FROM `rooms` WHERE `id` = NEW.`room_id`) != NEW.`event_id`
    OR NOT EXISTS (
      SELECT 1 FROM `acceptances`
      WHERE `event_id` = NEW.`event_id`
        AND `program_session_id` = NEW.`program_session_id`
    )
  THEN RAISE(ABORT, 'placement references must belong to one accepted event session') END;
END;

CREATE TRIGGER `placements_same_event_update`
BEFORE UPDATE ON `schedule_placements`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `program_sessions` WHERE `id` = NEW.`program_session_id`) != NEW.`event_id`
    OR (SELECT `event_id` FROM `event_days` WHERE `id` = NEW.`event_day_id`) != NEW.`event_id`
    OR (SELECT `event_id` FROM `rooms` WHERE `id` = NEW.`room_id`) != NEW.`event_id`
    OR NOT EXISTS (
      SELECT 1 FROM `acceptances`
      WHERE `event_id` = NEW.`event_id`
        AND `program_session_id` = NEW.`program_session_id`
    )
  THEN RAISE(ABORT, 'placement references must belong to one accepted event session') END;
END;

CREATE TRIGGER `placements_no_room_overlap_insert`
BEFORE INSERT ON `schedule_placements`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `schedule_placements` AS existing
    WHERE existing.`event_id` = NEW.`event_id`
      AND existing.`room_id` = NEW.`room_id`
      AND NEW.`starts_at` < existing.`ends_at`
      AND existing.`starts_at` < NEW.`ends_at`
  ) THEN RAISE(ABORT, 'schedule placement overlaps an existing room booking') END;
END;

CREATE TRIGGER `placements_no_room_overlap_update`
BEFORE UPDATE ON `schedule_placements`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `schedule_placements` AS existing
    WHERE existing.`id` != OLD.`id`
      AND existing.`event_id` = NEW.`event_id`
      AND existing.`room_id` = NEW.`room_id`
      AND NEW.`starts_at` < existing.`ends_at`
      AND existing.`starts_at` < NEW.`ends_at`
  ) THEN RAISE(ABORT, 'schedule placement overlaps an existing room booking') END;
END;
