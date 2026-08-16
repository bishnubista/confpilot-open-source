PRAGMA defer_foreign_keys = true;

ALTER TABLE `user_credentials` RENAME TO `user_credentials_legacy`;

CREATE TABLE `user_credentials` (
  `user_id` text PRIMARY KEY NOT NULL,
  `password_salt` text NOT NULL,
  `password_hash` text NOT NULL,
  `algorithm` text DEFAULT 'pbkdf2-sha256' NOT NULL,
  `iterations` integer NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (`algorithm` = 'pbkdf2-sha256'),
  CHECK (`iterations` IN (100000, 600000)),
  CHECK (length(`password_salt`) = 32),
  CHECK (`password_salt` NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(`password_hash`) = 64),
  CHECK (`password_hash` NOT GLOB '*[^0-9a-f]*')
);

INSERT INTO `user_credentials` (
  `user_id`, `password_salt`, `password_hash`, `algorithm`, `iterations`, `created_at`, `updated_at`
)
SELECT
  `user_id`, `password_salt`, `password_hash`, `algorithm`, `iterations`, `created_at`, `updated_at`
FROM `user_credentials_legacy`;

DROP TABLE `user_credentials_legacy`;

CREATE TRIGGER `user_credentials_supported_insert`
BEFORE INSERT ON `user_credentials`
WHEN NEW.`iterations` <> 100000
BEGIN
  SELECT RAISE(ABORT, 'new credentials must use the supported password work factor');
END;

CREATE TRIGGER `user_credentials_supported_material_update`
BEFORE UPDATE OF `password_salt`, `password_hash`, `algorithm`, `iterations` ON `user_credentials`
BEGIN
  SELECT CASE WHEN NEW.`algorithm` <> 'pbkdf2-sha256' OR NEW.`iterations` <> 100000
    THEN RAISE(ABORT, 'credential updates must use the supported password work factor') END;
  SELECT CASE WHEN OLD.`iterations` = 600000
      AND (NEW.`password_salt` = OLD.`password_salt` OR NEW.`password_hash` = OLD.`password_hash`)
    THEN RAISE(ABORT, 'legacy credential upgrades require a new salt and hash') END;
END;
