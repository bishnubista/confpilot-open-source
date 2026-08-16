CREATE TABLE `cfp_configs` (
  `event_id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `opens_at` text NOT NULL,
  `closes_at` text NOT NULL,
  `confirmation_message` text NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`status` IN ('draft', 'published')),
  CHECK (`opens_at` < `closes_at`),
  CHECK (`revision` > 0)
);

CREATE TABLE `cfp_fields` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `field_key` text NOT NULL,
  `section` text NOT NULL,
  `field_type` text NOT NULL,
  `label` text NOT NULL,
  `help_text` text DEFAULT '' NOT NULL,
  `required` integer DEFAULT 0 NOT NULL,
  `options_json` text DEFAULT '[]' NOT NULL,
  `sort_order` integer NOT NULL,
  `show_when_field_key` text,
  `show_when_value` text,
  `active` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`section` IN ('session', 'speaker')),
  CHECK (`field_type` IN ('short_text', 'long_text', 'dropdown')),
  CHECK (`required` IN (0, 1)),
  CHECK (`active` IN (0, 1)),
  CHECK (json_valid(`options_json`)),
  CHECK ((`show_when_field_key` IS NULL) = (`show_when_value` IS NULL))
);
CREATE UNIQUE INDEX `cfp_fields_event_key_unique` ON `cfp_fields` (`event_id`, `field_key`);
CREATE INDEX `cfp_fields_event_order_index` ON `cfp_fields` (`event_id`, `active`, `sort_order`);

DROP INDEX `speakers_event_name_unique`;

ALTER TABLE `proposals` ADD COLUMN `owner_user_id` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `proposals` ADD COLUMN `client_draft_key` text;
CREATE UNIQUE INDEX `proposals_event_owner_draft_key_unique`
  ON `proposals` (`event_id`, `owner_user_id`, `client_draft_key`)
  WHERE `owner_user_id` IS NOT NULL AND `client_draft_key` IS NOT NULL;
CREATE INDEX `proposals_event_owner_status_index` ON `proposals` (`event_id`, `owner_user_id`, `status`);

CREATE TABLE `proposal_answers` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `proposal_id` text NOT NULL,
  `field_key` text NOT NULL,
  `value` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`proposal_id`) REFERENCES `proposals` (`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `proposal_answers_event_proposal_field_unique`
  ON `proposal_answers` (`event_id`, `proposal_id`, `field_key`);

CREATE TRIGGER `proposals_owner_scope_insert`
BEFORE INSERT ON `proposals`
WHEN NEW.`owner_user_id` IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`owner_user_id`
      AND `role` = 'speaker'
  ) THEN RAISE(ABORT, 'proposal owner must be a speaker for the same event') END;
END;

CREATE TRIGGER `proposals_owner_scope_update`
BEFORE UPDATE OF `event_id`, `owner_user_id` ON `proposals`
BEGIN
  SELECT CASE WHEN NEW.`owner_user_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`owner_user_id`
      AND `role` = 'speaker'
  ) THEN RAISE(ABORT, 'proposal owner must be a speaker for the same event') END;
END;

CREATE TRIGGER `event_memberships_proposal_owner_delete`
BEFORE DELETE ON `event_memberships`
WHEN OLD.`role` = 'speaker'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `proposals`
    WHERE `event_id` = OLD.`event_id` AND `owner_user_id` = OLD.`user_id`
  ) THEN RAISE(ABORT, 'speaker membership with owned proposals cannot be removed') END;
END;

CREATE TRIGGER `event_memberships_proposal_owner_update`
BEFORE UPDATE OF `event_id`, `user_id`, `role` ON `event_memberships`
WHEN OLD.`role` = 'speaker'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM `proposals`
    WHERE `event_id` = OLD.`event_id` AND `owner_user_id` = OLD.`user_id`
  ) AND (NEW.`event_id` != OLD.`event_id` OR NEW.`user_id` != OLD.`user_id` OR NEW.`role` != 'speaker')
  THEN RAISE(ABORT, 'speaker membership with owned proposals cannot change scope') END;
END;

CREATE TRIGGER `proposal_presenters_owner_insert`
BEFORE INSERT ON `proposal_presenters`
WHEN NEW.`role` = 'primary'
  AND (SELECT `owner_user_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `speakers` AS speaker
    INNER JOIN `proposals` AS proposal ON proposal.id = NEW.`proposal_id`
    WHERE speaker.id = NEW.`speaker_id` AND speaker.user_id = proposal.owner_user_id
  )
  THEN RAISE(ABORT, 'owned proposal primary presenter must match its owner') END;
END;

CREATE TRIGGER `proposal_presenters_owner_update`
BEFORE UPDATE OF `proposal_id`, `speaker_id` ON `proposal_presenters`
WHEN NEW.`role` = 'primary'
  AND (SELECT `owner_user_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `speakers` AS speaker
    INNER JOIN `proposals` AS proposal ON proposal.id = NEW.`proposal_id`
    WHERE speaker.id = NEW.`speaker_id` AND speaker.user_id = proposal.owner_user_id
  )
  THEN RAISE(ABORT, 'owned proposal primary presenter must match its owner') END;
END;

CREATE TRIGGER `proposal_answers_scope_insert`
BEFORE INSERT ON `proposal_answers`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) IS NOT NEW.`event_id`
    OR NOT EXISTS (
      SELECT 1 FROM `cfp_fields`
      WHERE `event_id` = NEW.`event_id` AND `field_key` = NEW.`field_key`
    )
  THEN RAISE(ABORT, 'proposal answer must use a field from the same event') END;
END;

CREATE TRIGGER `proposal_answers_scope_update`
BEFORE UPDATE OF `event_id`, `proposal_id`, `field_key` ON `proposal_answers`
BEGIN
  SELECT CASE WHEN
    (SELECT `event_id` FROM `proposals` WHERE `id` = NEW.`proposal_id`) IS NOT NEW.`event_id`
    OR NOT EXISTS (
      SELECT 1 FROM `cfp_fields`
      WHERE `event_id` = NEW.`event_id` AND `field_key` = NEW.`field_key`
    )
  THEN RAISE(ABORT, 'proposal answer must use a field from the same event') END;
END;

CREATE TRIGGER `proposal_answers_locked_insert`
BEFORE INSERT ON `proposal_answers`
WHEN COALESCE((SELECT `status` FROM `proposals` WHERE `id` = NEW.`proposal_id`), 'missing') NOT IN ('draft', 'submitted')
BEGIN
  SELECT RAISE(ABORT, 'answers for reviewed proposals are immutable');
END;

CREATE TRIGGER `proposal_answers_locked_update`
BEFORE UPDATE ON `proposal_answers`
WHEN COALESCE((SELECT `status` FROM `proposals` WHERE `id` = OLD.`proposal_id`), 'missing') NOT IN ('draft', 'submitted')
BEGIN
  SELECT RAISE(ABORT, 'answers for reviewed proposals are immutable');
END;

CREATE TRIGGER `proposal_answers_locked_delete`
BEFORE DELETE ON `proposal_answers`
WHEN COALESCE((SELECT `status` FROM `proposals` WHERE `id` = OLD.`proposal_id`), 'missing') NOT IN ('draft', 'submitted')
BEGIN
  SELECT RAISE(ABORT, 'answers for reviewed proposals are immutable');
END;
