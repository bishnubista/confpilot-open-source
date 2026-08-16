import type { Database } from "./runtime/database";

export interface UnownedSpeaker {
  id: string;
}

export function unownedSpeakerByEmail(
  database: Database,
  eventId: string,
  email: string,
) {
  const normalizedEmail = email.trim().toLowerCase();
  return database.prepare(`SELECT id FROM speakers
    WHERE event_id = ? AND user_id IS NULL AND lower(trim(contact_email)) = ? LIMIT 1`)
    .bind(eventId, normalizedEmail).first<UnownedSpeaker>();
}
