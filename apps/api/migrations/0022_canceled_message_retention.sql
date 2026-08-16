DROP TRIGGER IF EXISTS `message_outbox_active_delete`;
CREATE TRIGGER `message_outbox_active_delete`
BEFORE DELETE ON `message_outbox`
WHEN OLD.`state` = 'leased'
  OR (OLD.`state` NOT IN ('delivered', 'failed') AND OLD.`canceled_at` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'active message delivery cannot be deleted');
END;
