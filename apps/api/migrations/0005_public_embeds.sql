ALTER TABLE `events` ADD COLUMN `time_zone` text NOT NULL DEFAULT 'UTC'
CHECK (`time_zone` = trim(`time_zone`) AND length(`time_zone`) BETWEEN 1 AND 64);

CREATE TABLE `public_embed_configs` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `view` text NOT NULL,
  `filters_json` text NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_by_user_id` text NOT NULL,
  `updated_by_user_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE restrict,
  CHECK (length(`id`) BETWEEN 1 AND 128),
  CHECK (
    length(`slug`) BETWEEN 1 AND 128
    AND `slug` = lower(trim(`slug`))
    AND `slug` NOT GLOB '*[^a-z0-9-]*'
    AND `slug` NOT LIKE '-%'
    AND `slug` NOT LIKE '%-'
    AND `slug` NOT LIKE '%--%'
  ),
  CHECK (`name` = trim(`name`) AND length(`name`) BETWEEN 1 AND 120),
  CHECK (`view` IN ('sessions', 'speakers', 'agenda', 'itinerary', 'gallery')),
  CHECK (json_valid(`filters_json`) AND json_type(`filters_json`) = 'object'),
  CHECK (`enabled` IN (0, 1)),
  CHECK (`revision` > 0),
  CHECK (`created_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `created_at`)),
  CHECK (`updated_at` IS strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`)),
  CHECK (`created_at` <= `updated_at`)
);

CREATE UNIQUE INDEX `public_embed_configs_event_slug_unique`
ON `public_embed_configs` (`event_id`, `slug`);

CREATE INDEX `public_embed_configs_event_updated_index`
ON `public_embed_configs` (`event_id`, `updated_at` DESC, `id`);

CREATE INDEX `public_embed_configs_public_lookup_index`
ON `public_embed_configs` (`event_id`, `slug`, `enabled`);

CREATE TRIGGER `public_embed_configs_valid_insert`
BEFORE INSERT ON `public_embed_configs`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`created_by_user_id`
      AND `role` = 'organizer'
  ) OR NEW.`updated_by_user_id` != NEW.`created_by_user_id`
  THEN RAISE(ABORT, 'public embed config requires an organizer in the same event') END;

  SELECT CASE WHEN NEW.`revision` != 1 OR NEW.`created_at` != NEW.`updated_at`
  THEN RAISE(ABORT, 'public embed config must start at revision one') END;

  SELECT CASE WHEN
    NEW.`filters_json` != json(NEW.`filters_json`)
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`)) != 4
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`)
      WHERE `key` NOT IN ('days', 'tracks', 'formats', 'rooms')
    )
    OR json_type(NEW.`filters_json`, '$.days') != 'array'
    OR json_type(NEW.`filters_json`, '$.tracks') != 'array'
    OR json_type(NEW.`filters_json`, '$.formats') != 'array'
    OR json_type(NEW.`filters_json`, '$.rooms') != 'array'
  THEN RAISE(ABORT, 'public embed filters must use the normalized strict shape') END;

  SELECT CASE WHEN
    json_array_length(NEW.`filters_json`, '$.days') > 31
    OR json_array_length(NEW.`filters_json`, '$.tracks') > 100
    OR json_array_length(NEW.`filters_json`, '$.formats') > 5
    OR json_array_length(NEW.`filters_json`, '$.rooms') > 100
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.days')
      WHERE `type` != 'text' OR `value` NOT GLOB '????-??-??'
        OR `value` IS NOT strftime('%Y-%m-%d', `value`)
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.tracks')
      WHERE `type` != 'text' OR `value` != trim(`value`)
        OR length(`value`) NOT BETWEEN 1 AND 160
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.formats')
      WHERE `type` != 'text'
        OR `value` NOT IN ('keynote', 'talk', 'lightning', 'workshop', 'panel')
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.rooms')
      WHERE `type` != 'text' OR `value` != trim(`value`)
        OR length(`value`) NOT BETWEEN 1 AND 160
    )
  THEN RAISE(ABORT, 'public embed filter values are invalid') END;

  SELECT CASE WHEN
    (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.days'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.days'))
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.tracks'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.tracks'))
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.formats'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.formats'))
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.rooms'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.rooms'))
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.days') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.days') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.tracks') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.tracks') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.formats') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.formats') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.rooms') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.rooms') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
  THEN RAISE(ABORT, 'public embed filter arrays must be unique and sorted') END;
END;

CREATE TRIGGER `public_embed_configs_identity_immutable_update`
BEFORE UPDATE OF `id`, `event_id`, `slug`, `created_by_user_id`, `created_at`
ON `public_embed_configs`
BEGIN
  SELECT RAISE(ABORT, 'public embed event and public identity are immutable');
END;

CREATE TRIGGER `public_embed_configs_valid_update`
BEFORE UPDATE ON `public_embed_configs`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`updated_by_user_id`
      AND `role` = 'organizer'
  ) THEN RAISE(ABORT, 'public embed update requires an organizer in the same event') END;

  SELECT CASE WHEN
    NEW.`revision` != OLD.`revision` + 1
    OR NEW.`updated_at` < OLD.`updated_at`
  THEN RAISE(ABORT, 'public embed update requires the next revision') END;

  SELECT CASE WHEN
    NEW.`filters_json` != json(NEW.`filters_json`)
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`)) != 4
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`)
      WHERE `key` NOT IN ('days', 'tracks', 'formats', 'rooms')
    )
    OR json_type(NEW.`filters_json`, '$.days') != 'array'
    OR json_type(NEW.`filters_json`, '$.tracks') != 'array'
    OR json_type(NEW.`filters_json`, '$.formats') != 'array'
    OR json_type(NEW.`filters_json`, '$.rooms') != 'array'
  THEN RAISE(ABORT, 'public embed filters must use the normalized strict shape') END;

  SELECT CASE WHEN
    json_array_length(NEW.`filters_json`, '$.days') > 31
    OR json_array_length(NEW.`filters_json`, '$.tracks') > 100
    OR json_array_length(NEW.`filters_json`, '$.formats') > 5
    OR json_array_length(NEW.`filters_json`, '$.rooms') > 100
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.days')
      WHERE `type` != 'text' OR `value` NOT GLOB '????-??-??'
        OR `value` IS NOT strftime('%Y-%m-%d', `value`)
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.tracks')
      WHERE `type` != 'text' OR `value` != trim(`value`)
        OR length(`value`) NOT BETWEEN 1 AND 160
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.formats')
      WHERE `type` != 'text'
        OR `value` NOT IN ('keynote', 'talk', 'lightning', 'workshop', 'panel')
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.rooms')
      WHERE `type` != 'text' OR `value` != trim(`value`)
        OR length(`value`) NOT BETWEEN 1 AND 160
    )
  THEN RAISE(ABORT, 'public embed filter values are invalid') END;

  SELECT CASE WHEN
    (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.days'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.days'))
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.tracks'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.tracks'))
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.formats'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.formats'))
    OR (SELECT COUNT(*) FROM json_each(NEW.`filters_json`, '$.rooms'))
      != (SELECT COUNT(DISTINCT `value`) FROM json_each(NEW.`filters_json`, '$.rooms'))
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.days') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.days') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.tracks') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.tracks') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.formats') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.formats') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.`filters_json`, '$.rooms') AS earlier
      INNER JOIN json_each(NEW.`filters_json`, '$.rooms') AS later
        ON CAST(earlier.`key` AS integer) < CAST(later.`key` AS integer)
      WHERE earlier.`value` > later.`value`
    )
  THEN RAISE(ABORT, 'public embed filter arrays must be unique and sorted') END;
END;

CREATE TRIGGER `public_embed_configs_immutable_delete`
BEFORE DELETE ON `public_embed_configs`
BEGIN
  SELECT RAISE(ABORT, 'public embed configs cannot be deleted; disable them instead');
END;
