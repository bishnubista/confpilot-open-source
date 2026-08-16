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
  CHECK (`iterations` = 600000),
  CHECK (length(`password_salt`) = 32),
  CHECK (`password_salt` NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(`password_hash`) = 64),
  CHECK (`password_hash` NOT GLOB '*[^0-9a-f]*')
);

CREATE UNIQUE INDEX `users_email_normalized_unique`
ON `users` (lower(trim(`email`)));
