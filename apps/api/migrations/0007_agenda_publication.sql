ALTER TABLE `events` ADD COLUMN `agenda_published_at` text
CHECK (`agenda_published_at` IS NULL OR `agenda_published_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `agenda_published_at`));

ALTER TABLE `rooms` ADD COLUMN `revision` integer NOT NULL DEFAULT 1 CHECK (`revision` > 0);
ALTER TABLE `rooms` ADD COLUMN `created_by_user_id` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `rooms` ADD COLUMN `updated_by_user_id` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `rooms` ADD COLUMN `created_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z'
CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`));
ALTER TABLE `rooms` ADD COLUMN `updated_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z'
CHECK (`updated_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`));

ALTER TABLE `event_days` ADD COLUMN `opens_at` text NOT NULL DEFAULT '0001-01-01T00:00:00Z'
CHECK (`opens_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `opens_at`));
ALTER TABLE `event_days` ADD COLUMN `closes_at` text NOT NULL DEFAULT '9999-12-31T23:59:59Z'
CHECK (`closes_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `closes_at`) AND `opens_at` < `closes_at`);
ALTER TABLE `event_days` ADD COLUMN `slot_minutes` integer NOT NULL DEFAULT 15
CHECK (`slot_minutes` IN (5, 10, 15, 20, 30, 60));
ALTER TABLE `event_days` ADD COLUMN `revision` integer NOT NULL DEFAULT 1 CHECK (`revision` > 0);
ALTER TABLE `event_days` ADD COLUMN `created_by_user_id` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `event_days` ADD COLUMN `updated_by_user_id` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `event_days` ADD COLUMN `created_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z'
CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`));
ALTER TABLE `event_days` ADD COLUMN `updated_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z'
CHECK (`updated_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`));

ALTER TABLE `schedule_placements` ADD COLUMN `revision` integer NOT NULL DEFAULT 1 CHECK (`revision` > 0);
ALTER TABLE `schedule_placements` ADD COLUMN `created_by_user_id` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `schedule_placements` ADD COLUMN `updated_by_user_id` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict;
ALTER TABLE `schedule_placements` ADD COLUMN `created_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z'
CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`));
ALTER TABLE `schedule_placements` ADD COLUMN `updated_at` text NOT NULL DEFAULT '1970-01-01T00:00:00Z'
CHECK (`updated_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`));

CREATE TABLE `event_tracks` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `name` text NOT NULL,
  `color` text NOT NULL,
  `sort_order` integer NOT NULL,
  `revision` integer NOT NULL DEFAULT 1,
  `created_by_user_id` text NOT NULL,
  `updated_by_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (length(`id`) BETWEEN 1 AND 128),
  CHECK (`name` = trim(`name`) AND length(`name`) BETWEEN 1 AND 160),
  CHECK (`color` IN ('plum', 'blue', 'gold', 'teal', 'coral', 'slate')),
  CHECK (`sort_order` BETWEEN 0 AND 10000),
  CHECK (`revision` > 0),
  CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`)),
  CHECK (`updated_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`)),
  CHECK (`created_at` <= `updated_at`)
);

CREATE UNIQUE INDEX `event_tracks_event_name_normalized_unique`
ON `event_tracks` (`event_id`, lower(`name`));
CREATE INDEX `event_tracks_event_sort_index`
ON `event_tracks` (`event_id`, `sort_order`, `name`, `id`);

CREATE TABLE `_agenda_room_name_preflight` (
  `ok` integer NOT NULL,
  CONSTRAINT `agenda_room_names_must_be_unique` CHECK (`ok` = 1)
);
INSERT INTO `_agenda_room_name_preflight` (`ok`)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM `rooms`
  GROUP BY `event_id`, lower(trim(`name`)) HAVING COUNT(*) > 1
);
DROP TABLE `_agenda_room_name_preflight`;

CREATE UNIQUE INDEX `rooms_event_name_normalized_unique`
ON `rooms` (`event_id`, lower(trim(`name`)));
CREATE INDEX `placements_event_day_start_index`
ON `schedule_placements` (`event_id`, `event_day_id`, `starts_at`, `room_id`);

UPDATE `rooms`
SET `created_by_user_id` = (
      SELECT `user_id` FROM `event_memberships`
      WHERE `event_id` = `rooms`.`event_id` AND `role` = 'organizer'
      ORDER BY `created_at`, `id` LIMIT 1
    ),
    `updated_by_user_id` = (
      SELECT `user_id` FROM `event_memberships`
      WHERE `event_id` = `rooms`.`event_id` AND `role` = 'organizer'
      ORDER BY `created_at`, `id` LIMIT 1
    );

CREATE TABLE `_agenda_window_preflight` (
  `ok` integer NOT NULL,
  CONSTRAINT `agenda_legacy_placements_must_fit_one_day` CHECK (`ok` = 1)
);
INSERT INTO `_agenda_window_preflight` (`ok`)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM `schedule_placements`
  GROUP BY `event_id`, `event_day_id`
  HAVING unixepoch(MAX(`ends_at`)) - unixepoch(MIN(`starts_at`)) > 24 * 60 * 60
);
DROP TABLE `_agenda_window_preflight`;

CREATE TABLE `_agenda_continuity_preflight` (
  `ok` integer NOT NULL,
  CONSTRAINT `agenda_legacy_sessions_must_have_valid_continuity` CHECK (`ok` = 1)
);
INSERT INTO `_agenda_continuity_preflight` (`ok`)
SELECT 0 WHERE EXISTS (
  SELECT 1
  FROM `schedule_placements` AS `placement`
  INNER JOIN `program_sessions` AS `session`
    ON `session`.`event_id` = `placement`.`event_id`
    AND `session`.`id` = `placement`.`program_session_id`
  WHERE unixepoch(`placement`.`ends_at`) - unixepoch(`placement`.`starts_at`)
    != `session`.`duration_minutes` * 60
  UNION ALL
  SELECT 1
  FROM `program_sessions` AS `session`
  INNER JOIN `acceptances` AS `acceptance`
    ON `acceptance`.`event_id` = `session`.`event_id`
    AND `acceptance`.`program_session_id` = `session`.`id`
  LEFT JOIN `session_presenters` AS `presenter`
    ON `presenter`.`event_id` = `session`.`event_id`
    AND `presenter`.`program_session_id` = `session`.`id`
    AND `presenter`.`role` = 'primary'
  GROUP BY `session`.`event_id`, `session`.`id`
  HAVING COUNT(`presenter`.`id`) != 1
);
DROP TABLE `_agenda_continuity_preflight`;

UPDATE `event_days`
SET `opens_at` = COALESCE((
      SELECT CASE
        WHEN unixepoch(MAX(`ends_at`), '+60 minutes') - unixepoch(MIN(`starts_at`), '-60 minutes') <= 24 * 60 * 60
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', MIN(`starts_at`), '-60 minutes')
        ELSE MIN(`starts_at`)
      END
      FROM `schedule_placements`
      WHERE `event_id` = `event_days`.`event_id` AND `event_day_id` = `event_days`.`id`
    ), `date` || 'T09:00:00Z'),
    `closes_at` = COALESCE((
      SELECT CASE
        WHEN unixepoch(MAX(`ends_at`), '+60 minutes') - unixepoch(MIN(`starts_at`), '-60 minutes') <= 24 * 60 * 60
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', MAX(`ends_at`), '+60 minutes')
        ELSE MAX(`ends_at`)
      END
      FROM `schedule_placements`
      WHERE `event_id` = `event_days`.`event_id` AND `event_day_id` = `event_days`.`id`
    ), `date` || 'T17:00:00Z'),
    `created_by_user_id` = (
      SELECT `user_id` FROM `event_memberships`
      WHERE `event_id` = `event_days`.`event_id` AND `role` = 'organizer'
      ORDER BY `created_at`, `id` LIMIT 1
    ),
    `updated_by_user_id` = (
      SELECT `user_id` FROM `event_memberships`
      WHERE `event_id` = `event_days`.`event_id` AND `role` = 'organizer'
      ORDER BY `created_at`, `id` LIMIT 1
    );

-- Preserve populated schedules by choosing the coarsest supported grid that
-- contains every legacy start time relative to the backfilled operating window.
UPDATE `event_days`
SET `slot_minutes` = CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM `schedule_placements` AS `placement`
    WHERE `placement`.`event_id` = `event_days`.`event_id`
      AND `placement`.`event_day_id` = `event_days`.`id`
      AND (unixepoch(`placement`.`starts_at`) - unixepoch(`event_days`.`opens_at`)) % (15 * 60) != 0
  ) THEN 15
  WHEN NOT EXISTS (
    SELECT 1 FROM `schedule_placements` AS `placement`
    WHERE `placement`.`event_id` = `event_days`.`event_id`
      AND `placement`.`event_day_id` = `event_days`.`id`
      AND (unixepoch(`placement`.`starts_at`) - unixepoch(`event_days`.`opens_at`)) % (10 * 60) != 0
  ) THEN 10
  WHEN NOT EXISTS (
    SELECT 1 FROM `schedule_placements` AS `placement`
    WHERE `placement`.`event_id` = `event_days`.`event_id`
      AND `placement`.`event_day_id` = `event_days`.`id`
      AND (unixepoch(`placement`.`starts_at`) - unixepoch(`event_days`.`opens_at`)) % (5 * 60) != 0
  ) THEN 5
  -- Keep sub-five-minute legacy placements visible; organizers can move them
  -- onto the five-minute grid because write triggers validate the new values.
  ELSE 5
END
WHERE EXISTS (
  SELECT 1 FROM `schedule_placements` AS `placement`
  WHERE `placement`.`event_id` = `event_days`.`event_id`
    AND `placement`.`event_day_id` = `event_days`.`id`
);

UPDATE `schedule_placements`
SET `created_by_user_id` = (
      SELECT `user_id` FROM `event_memberships`
      WHERE `event_id` = `schedule_placements`.`event_id` AND `role` = 'organizer'
      ORDER BY `created_at`, `id` LIMIT 1
    ),
    `updated_by_user_id` = (
      SELECT `user_id` FROM `event_memberships`
      WHERE `event_id` = `schedule_placements`.`event_id` AND `role` = 'organizer'
      ORDER BY `created_at`, `id` LIMIT 1
    );

WITH `track_names` AS (
  SELECT `event_id`, trim(`track`) AS `name` FROM `program_sessions`
  UNION
  SELECT `event_id`, trim(`track`) AS `name` FROM `proposals`
  UNION
  SELECT `field`.`event_id`, trim(json_extract(`option`.`value`, '$.value')) AS `name`
  FROM `cfp_fields` AS `field`, json_each(`field`.`options_json`) AS `option`
  WHERE `field`.`field_key` = 'track' AND `field`.`active` = 1
), `normalized_tracks` AS (
  SELECT `event_id`, MIN(`name`) AS `name`
  FROM `track_names`
  WHERE length(`name`) BETWEEN 1 AND 160
  GROUP BY `event_id`, lower(`name`)
), `ranked_tracks` AS (
  SELECT `event_id`, `name`, row_number() OVER (
    PARTITION BY `event_id` ORDER BY `name` COLLATE NOCASE, `name`
  ) AS `sort_order`
  FROM `normalized_tracks`
), `organizers` AS (
  SELECT `event_id`, `user_id`, row_number() OVER (
    PARTITION BY `event_id` ORDER BY `created_at`, `id`
  ) AS `organizer_order`
  FROM `event_memberships` WHERE `role` = 'organizer'
)
INSERT INTO `event_tracks` (
  `id`, `event_id`, `name`, `color`, `sort_order`, `revision`,
  `created_by_user_id`, `updated_by_user_id`, `created_at`, `updated_at`
)
SELECT 'track-' || `track`.`event_id` || '-' || `track`.`sort_order`,
  `track`.`event_id`, `track`.`name`,
  CASE ((`track`.`sort_order` - 1) % 6)
    WHEN 0 THEN 'plum' WHEN 1 THEN 'blue' WHEN 2 THEN 'gold'
    WHEN 3 THEN 'teal' WHEN 4 THEN 'coral' ELSE 'slate' END,
  `track`.`sort_order`, 1, `organizer`.`user_id`, `organizer`.`user_id`,
  '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'
FROM `ranked_tracks` AS `track`
INNER JOIN `organizers` AS `organizer`
  ON `organizer`.`event_id` = `track`.`event_id` AND `organizer`.`organizer_order` = 1;

CREATE TRIGGER `event_tracks_valid_insert`
BEFORE INSERT ON `event_tracks`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`created_by_user_id`
      AND `role` = 'organizer'
  ) OR NEW.`updated_by_user_id` != NEW.`created_by_user_id`
  THEN RAISE(ABORT, 'agenda track requires a same-event organizer') END;
  SELECT CASE WHEN NEW.`revision` != 1 OR NEW.`created_at` != NEW.`updated_at`
  THEN RAISE(ABORT, 'agenda track must start at revision one') END;
END;

CREATE TRIGGER `event_tracks_valid_update`
BEFORE UPDATE ON `event_tracks`
BEGIN
  SELECT CASE WHEN NEW.`id` != OLD.`id` OR NEW.`event_id` != OLD.`event_id`
    OR NEW.`name` != OLD.`name` OR NEW.`created_by_user_id` != OLD.`created_by_user_id`
    OR NEW.`created_at` != OLD.`created_at`
  THEN RAISE(ABORT, 'agenda track identity is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`updated_by_user_id`
      AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'agenda track update requires a same-event organizer') END;
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
  THEN RAISE(ABORT, 'agenda track update requires the next revision and later timestamp') END;
  SELECT CASE WHEN NEW.`color` IS OLD.`color` AND NEW.`sort_order` IS OLD.`sort_order`
  THEN RAISE(ABORT, 'agenda track revision requires a track change') END;
END;

CREATE TRIGGER `event_tracks_immutable_delete`
BEFORE DELETE ON `event_tracks`
BEGIN
  SELECT RAISE(ABORT, 'agenda tracks cannot be deleted');
END;

CREATE TRIGGER `rooms_valid_insert`
BEFORE INSERT ON `rooms`
BEGIN
  SELECT CASE WHEN NEW.`revision` != 1 OR NEW.`created_at` != NEW.`updated_at`
  THEN RAISE(ABORT, 'agenda room must start at revision one') END;
  SELECT CASE WHEN NOT (
    NEW.`created_by_user_id` IS NULL AND NEW.`updated_by_user_id` IS NULL
      AND NEW.`created_at` = '1970-01-01T00:00:00Z'
    OR EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
    ) AND NEW.`updated_by_user_id` = NEW.`created_by_user_id`
  ) THEN RAISE(ABORT, 'agenda room requires a same-event organizer') END;
END;

CREATE TRIGGER `rooms_legacy_hydration_update`
BEFORE UPDATE ON `rooms`
WHEN OLD.`created_by_user_id` IS NULL AND OLD.`updated_by_user_id` IS NULL
  AND OLD.`created_at` = '1970-01-01T00:00:00Z' AND OLD.`updated_at` = OLD.`created_at`
BEGIN
  SELECT CASE WHEN NEW.`id` != OLD.`id` OR NEW.`event_id` != OLD.`event_id`
    OR NEW.`name` != OLD.`name` OR NEW.`capacity` != OLD.`capacity`
    OR NEW.`sort_order` != OLD.`sort_order` OR NEW.`revision` != 1
    OR NEW.`created_at` != NEW.`updated_at`
    OR NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
    ) OR NEW.`updated_by_user_id` != NEW.`created_by_user_id`
  THEN RAISE(ABORT, 'legacy agenda room hydration is invalid') END;
END;

CREATE TRIGGER `rooms_valid_update`
BEFORE UPDATE ON `rooms`
WHEN NOT (OLD.`created_by_user_id` IS NULL AND OLD.`updated_by_user_id` IS NULL
  AND OLD.`created_at` = '1970-01-01T00:00:00Z' AND OLD.`updated_at` = OLD.`created_at`)
BEGIN
  SELECT CASE WHEN NEW.`id` != OLD.`id` OR NEW.`event_id` != OLD.`event_id`
    OR NEW.`created_by_user_id` != OLD.`created_by_user_id` OR NEW.`created_at` != OLD.`created_at`
  THEN RAISE(ABORT, 'agenda room identity is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`updated_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'agenda room update requires a same-event organizer') END;
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
  THEN RAISE(ABORT, 'agenda room update requires the next revision and later timestamp') END;
  SELECT CASE WHEN NEW.`name` IS OLD.`name` AND NEW.`capacity` IS OLD.`capacity`
    AND NEW.`sort_order` IS OLD.`sort_order`
  THEN RAISE(ABORT, 'agenda room revision requires a room change') END;
END;

CREATE TRIGGER `rooms_immutable_delete`
BEFORE DELETE ON `rooms`
BEGIN
  SELECT RAISE(ABORT, 'agenda rooms cannot be deleted');
END;

CREATE TRIGGER `event_days_valid_insert`
BEFORE INSERT ON `event_days`
BEGIN
  SELECT CASE WHEN NEW.`revision` != 1 OR NEW.`created_at` != NEW.`updated_at`
  THEN RAISE(ABORT, 'agenda day must start at revision one') END;
  SELECT CASE WHEN NEW.`date` < (SELECT `starts_on` FROM `events` WHERE `id` = NEW.`event_id`)
    OR NEW.`date` > (SELECT `ends_on` FROM `events` WHERE `id` = NEW.`event_id`)
  THEN RAISE(ABORT, 'agenda day date must be inside the event') END;
  SELECT CASE WHEN NOT (
    NEW.`created_by_user_id` IS NULL AND NEW.`updated_by_user_id` IS NULL
      AND NEW.`created_at` = '1970-01-01T00:00:00Z'
    OR EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
    ) AND NEW.`updated_by_user_id` = NEW.`created_by_user_id`
      AND CAST(strftime('%s', NEW.`closes_at`) AS integer) - CAST(strftime('%s', NEW.`opens_at`) AS integer) <= 86400
  ) THEN RAISE(ABORT, 'agenda day requires a same-event organizer and bounded operating window') END;
END;

CREATE TRIGGER `event_days_legacy_hydration_update`
BEFORE UPDATE ON `event_days`
WHEN OLD.`created_by_user_id` IS NULL AND OLD.`updated_by_user_id` IS NULL
  AND OLD.`created_at` = '1970-01-01T00:00:00Z' AND OLD.`updated_at` = OLD.`created_at`
BEGIN
  SELECT CASE WHEN NEW.`id` != OLD.`id` OR NEW.`event_id` != OLD.`event_id`
    OR NEW.`day_number` != OLD.`day_number` OR NEW.`date` != OLD.`date`
    OR NEW.`label` != OLD.`label` OR NEW.`revision` != 1
    OR NEW.`created_at` != NEW.`updated_at`
    OR NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
    ) OR NEW.`updated_by_user_id` != NEW.`created_by_user_id`
    OR CAST(strftime('%s', NEW.`closes_at`) AS integer) - CAST(strftime('%s', NEW.`opens_at`) AS integer) > 86400
  THEN RAISE(ABORT, 'legacy agenda day hydration is invalid') END;
END;

CREATE TRIGGER `event_days_valid_update`
BEFORE UPDATE ON `event_days`
WHEN NOT (OLD.`created_by_user_id` IS NULL AND OLD.`updated_by_user_id` IS NULL
  AND OLD.`created_at` = '1970-01-01T00:00:00Z' AND OLD.`updated_at` = OLD.`created_at`)
BEGIN
  SELECT CASE WHEN NEW.`id` != OLD.`id` OR NEW.`event_id` != OLD.`event_id`
    OR NEW.`day_number` != OLD.`day_number` OR NEW.`created_by_user_id` != OLD.`created_by_user_id`
    OR NEW.`created_at` != OLD.`created_at`
  THEN RAISE(ABORT, 'agenda day identity is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`updated_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'agenda day update requires a same-event organizer') END;
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
  THEN RAISE(ABORT, 'agenda day update requires the next revision and later timestamp') END;
  SELECT CASE WHEN CAST(strftime('%s', NEW.`closes_at`) AS integer) - CAST(strftime('%s', NEW.`opens_at`) AS integer) > 86400
  THEN RAISE(ABORT, 'agenda day operating window cannot exceed 24 hours') END;
  SELECT CASE WHEN (NEW.`date` != OLD.`date` OR NEW.`opens_at` != OLD.`opens_at`
      OR NEW.`closes_at` != OLD.`closes_at` OR NEW.`slot_minutes` != OLD.`slot_minutes`)
    AND EXISTS (
      SELECT 1 FROM `schedule_placements`
      WHERE `event_id` = OLD.`event_id` AND `event_day_id` = OLD.`id`
    )
  THEN RAISE(ABORT, 'agenda day is referenced; unplace sessions first') END;
  SELECT CASE WHEN NEW.`date` IS OLD.`date` AND NEW.`label` IS OLD.`label`
    AND NEW.`opens_at` IS OLD.`opens_at` AND NEW.`closes_at` IS OLD.`closes_at`
    AND NEW.`slot_minutes` IS OLD.`slot_minutes`
  THEN RAISE(ABORT, 'agenda day revision requires a day change') END;
END;

CREATE TRIGGER `event_days_immutable_delete`
BEFORE DELETE ON `event_days`
BEGIN
  SELECT RAISE(ABORT, 'agenda days cannot be deleted');
END;

CREATE TRIGGER `placements_agenda_valid_insert`
BEFORE INSERT ON `schedule_placements`
BEGIN
  SELECT CASE WHEN NEW.`revision` != 1 OR NEW.`created_at` != NEW.`updated_at`
  THEN RAISE(ABORT, 'agenda placement must start at revision one') END;
  SELECT CASE WHEN NOT (
    NEW.`created_by_user_id` IS NULL AND NEW.`updated_by_user_id` IS NULL
      AND NEW.`created_at` = '1970-01-01T00:00:00Z'
    OR EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
    ) AND NEW.`updated_by_user_id` = NEW.`created_by_user_id`
  ) THEN RAISE(ABORT, 'agenda placement requires a same-event organizer') END;
  SELECT CASE WHEN NEW.`starts_at` < (SELECT `opens_at` FROM `event_days` WHERE `id` = NEW.`event_day_id`)
    OR NEW.`ends_at` > (SELECT `closes_at` FROM `event_days` WHERE `id` = NEW.`event_day_id`)
  THEN RAISE(ABORT, 'agenda placement must stay inside the day operating window') END;
  SELECT CASE WHEN (
    CAST(strftime('%s', NEW.`starts_at`) AS integer)
      - CAST(strftime('%s', (SELECT `opens_at` FROM `event_days` WHERE `id` = NEW.`event_day_id`)) AS integer)
    ) % ((SELECT `slot_minutes` FROM `event_days` WHERE `id` = NEW.`event_day_id`) * 60) != 0
  THEN RAISE(ABORT, 'agenda placement must align to the day slot interval') END;
  SELECT CASE WHEN CAST(strftime('%s', NEW.`ends_at`) AS integer)
      - CAST(strftime('%s', NEW.`starts_at`) AS integer)
      != (SELECT `duration_minutes` * 60 FROM `program_sessions` WHERE `id` = NEW.`program_session_id`)
  THEN RAISE(ABORT, 'agenda placement must match the session duration') END;
END;

CREATE TRIGGER `placements_agenda_valid_update`
BEFORE UPDATE ON `schedule_placements`
WHEN NOT (OLD.`created_by_user_id` IS NULL AND OLD.`updated_by_user_id` IS NULL
  AND OLD.`created_at` = '1970-01-01T00:00:00Z' AND OLD.`updated_at` = OLD.`created_at`)
  AND NEW.`starts_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`starts_at`)
  AND NEW.`ends_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`ends_at`)
BEGIN
  SELECT CASE WHEN NEW.`id` != OLD.`id` OR NEW.`event_id` != OLD.`event_id`
    OR NEW.`program_session_id` != OLD.`program_session_id`
    OR NEW.`created_by_user_id` != OLD.`created_by_user_id` OR NEW.`created_at` != OLD.`created_at`
  THEN RAISE(ABORT, 'agenda placement identity is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`updated_by_user_id` AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'agenda placement update requires a same-event organizer') END;
  SELECT CASE WHEN NEW.`revision` != OLD.`revision` + 1 OR NEW.`updated_at` <= OLD.`updated_at`
  THEN RAISE(ABORT, 'agenda placement update requires the next revision and later timestamp') END;
  SELECT CASE WHEN NEW.`starts_at` < (SELECT `opens_at` FROM `event_days` WHERE `id` = NEW.`event_day_id`)
    OR NEW.`ends_at` > (SELECT `closes_at` FROM `event_days` WHERE `id` = NEW.`event_day_id`)
  THEN RAISE(ABORT, 'agenda placement must stay inside the day operating window') END;
  SELECT CASE WHEN (
    CAST(strftime('%s', NEW.`starts_at`) AS integer)
      - CAST(strftime('%s', (SELECT `opens_at` FROM `event_days` WHERE `id` = NEW.`event_day_id`)) AS integer)
    ) % ((SELECT `slot_minutes` FROM `event_days` WHERE `id` = NEW.`event_day_id`) * 60) != 0
  THEN RAISE(ABORT, 'agenda placement must align to the day slot interval') END;
  SELECT CASE WHEN CAST(strftime('%s', NEW.`ends_at`) AS integer)
      - CAST(strftime('%s', NEW.`starts_at`) AS integer)
      != (SELECT `duration_minutes` * 60 FROM `program_sessions` WHERE `id` = NEW.`program_session_id`)
  THEN RAISE(ABORT, 'agenda placement must match the session duration') END;
  SELECT CASE WHEN NEW.`event_day_id` IS OLD.`event_day_id` AND NEW.`room_id` IS OLD.`room_id`
    AND NEW.`starts_at` IS OLD.`starts_at` AND NEW.`ends_at` IS OLD.`ends_at`
  THEN RAISE(ABORT, 'agenda placement revision requires a placement change') END;
END;

CREATE TRIGGER `placements_legacy_hydration_update`
BEFORE UPDATE ON `schedule_placements`
WHEN OLD.`created_by_user_id` IS NULL AND OLD.`updated_by_user_id` IS NULL
  AND OLD.`created_at` = '1970-01-01T00:00:00Z' AND OLD.`updated_at` = OLD.`created_at`
  AND NEW.`starts_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`starts_at`)
  AND NEW.`ends_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', NEW.`ends_at`)
BEGIN
  SELECT CASE WHEN NEW.`id` != OLD.`id` OR NEW.`event_id` != OLD.`event_id`
    OR NEW.`program_session_id` != OLD.`program_session_id` OR NEW.`event_day_id` != OLD.`event_day_id`
    OR NEW.`room_id` != OLD.`room_id` OR NEW.`starts_at` != OLD.`starts_at`
    OR NEW.`ends_at` != OLD.`ends_at` OR NEW.`revision` != 1
    OR NEW.`created_at` != NEW.`updated_at`
    OR NOT EXISTS (
      SELECT 1 FROM `event_memberships`
      WHERE `event_id` = NEW.`event_id` AND `user_id` = NEW.`created_by_user_id` AND `role` = 'organizer'
    ) OR NEW.`updated_by_user_id` != NEW.`created_by_user_id`
  THEN RAISE(ABORT, 'legacy agenda placement hydration is invalid') END;
END;

CREATE TRIGGER `program_sessions_duration_requires_unplaced`
BEFORE UPDATE OF `duration_minutes` ON `program_sessions`
WHEN NEW.`duration_minutes` != OLD.`duration_minutes`
  AND EXISTS (
    SELECT 1 FROM `schedule_placements`
    WHERE `event_id` = OLD.`event_id` AND `program_session_id` = OLD.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'unplace the session first before changing its duration');
END;
