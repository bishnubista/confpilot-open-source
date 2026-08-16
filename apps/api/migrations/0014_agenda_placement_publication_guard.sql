CREATE TRIGGER `schedule_placements_demote_published_delete`
AFTER DELETE ON `schedule_placements`
BEGIN
  UPDATE `program_sessions`
  SET `publication_status` = 'ready',
      `revision` = `revision` + 1,
      `updated_at` = CASE
        WHEN `updated_at` >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          THEN strftime('%Y-%m-%dT%H:%M:%SZ', `updated_at`, '+1 second')
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      END
  WHERE `event_id` = OLD.`event_id`
    AND `id` = OLD.`program_session_id`
    AND `publication_status` = 'published'
    AND NOT EXISTS (
      SELECT 1 FROM `schedule_placements` AS remaining
      WHERE remaining.`event_id` = `program_sessions`.`event_id`
        AND remaining.`program_session_id` = `program_sessions`.`id`
    );
END;
