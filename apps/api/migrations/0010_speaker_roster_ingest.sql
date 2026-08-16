CREATE UNIQUE INDEX `speakers_event_contact_email_normalized_unique`
ON `speakers` (`event_id`, lower(trim(`contact_email`)))
WHERE trim(`contact_email`) != '';
