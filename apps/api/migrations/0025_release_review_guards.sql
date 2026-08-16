DROP TRIGGER `speaker_claim_link_guard`;
CREATE TRIGGER `speaker_claim_link_guard`
BEFORE UPDATE OF `user_id` ON `speakers`
WHEN NEW.`user_id` IS NOT OLD.`user_id`
BEGIN
  SELECT CASE WHEN OLD.`user_id` IS NOT NULL AND NEW.`user_id` IS NOT NULL
    THEN RAISE(ABORT, 'speaker account link is immutable') END;
  SELECT CASE WHEN OLD.`user_id` IS NULL AND (NEW.`user_id` IS NULL OR NOT EXISTS (
    SELECT 1 FROM `speaker_claim_acceptances`
    WHERE `event_id` = NEW.`event_id`
      AND `speaker_id` = NEW.`id`
      AND `user_id` = NEW.`user_id`
  ) OR NOT EXISTS (
    SELECT 1 FROM `event_memberships`
    WHERE `event_id` = NEW.`event_id`
      AND `user_id` = NEW.`user_id`
      AND `role` = 'speaker'
  )) THEN RAISE(ABORT, 'speaker account link requires accepted same-event claim') END;
END;
