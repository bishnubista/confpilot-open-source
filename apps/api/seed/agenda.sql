UPDATE event_days
SET opens_at = date || 'T16:00:00Z',
    closes_at = CASE WHEN event_id = 'evt-devflow' THEN date || 'T23:00:00Z' ELSE date || 'T22:00:00Z' END,
    slot_minutes = 15,
    created_by_user_id = CASE event_id
      WHEN 'evt-devflow' THEN 'usr-devflow-organizer' ELSE 'usr-fieldnotes-organizer' END,
    updated_by_user_id = CASE event_id
      WHEN 'evt-devflow' THEN 'usr-devflow-organizer' ELSE 'usr-fieldnotes-organizer' END,
    created_at = '2027-03-01T18:00:00Z',
    updated_at = '2027-03-01T18:00:00Z'
WHERE event_id IN ('evt-devflow', 'evt-fieldnotes');

UPDATE rooms
SET created_by_user_id = CASE event_id
      WHEN 'evt-devflow' THEN 'usr-devflow-organizer' ELSE 'usr-fieldnotes-organizer' END,
    updated_by_user_id = CASE event_id
      WHEN 'evt-devflow' THEN 'usr-devflow-organizer' ELSE 'usr-fieldnotes-organizer' END,
    created_at = '2027-03-01T18:00:00Z',
    updated_at = '2027-03-01T18:00:00Z'
WHERE event_id IN ('evt-devflow', 'evt-fieldnotes');

UPDATE schedule_placements
SET created_by_user_id = CASE event_id
      WHEN 'evt-devflow' THEN 'usr-devflow-organizer' ELSE 'usr-fieldnotes-organizer' END,
    updated_by_user_id = CASE event_id
      WHEN 'evt-devflow' THEN 'usr-devflow-organizer' ELSE 'usr-fieldnotes-organizer' END,
    created_at = '2027-03-15T18:00:00Z',
    updated_at = '2027-03-15T18:00:00Z'
WHERE event_id IN ('evt-devflow', 'evt-fieldnotes');

INSERT INTO event_tracks (
  id, event_id, name, color, sort_order, revision,
  created_by_user_id, updated_by_user_id, created_at, updated_at
) VALUES
  ('track-d-ai', 'evt-devflow', 'AI Engineering', 'plum', 1, 1,
    'usr-devflow-organizer', 'usr-devflow-organizer', '2027-03-01T18:00:00Z', '2027-03-01T18:00:00Z'),
  ('track-d-platform', 'evt-devflow', 'Platform & Infra', 'blue', 2, 1,
    'usr-devflow-organizer', 'usr-devflow-organizer', '2027-03-01T18:00:00Z', '2027-03-01T18:00:00Z'),
  ('track-d-developer-experience', 'evt-devflow', 'Developer Experience', 'gold', 3, 1,
    'usr-devflow-organizer', 'usr-devflow-organizer', '2027-03-01T18:00:00Z', '2027-03-01T18:00:00Z'),
  ('track-f-programming', 'evt-fieldnotes', 'Programming', 'plum', 1, 1,
    'usr-fieldnotes-organizer', 'usr-fieldnotes-organizer', '2027-03-01T18:00:00Z', '2027-03-01T18:00:00Z'),
  ('track-f-experience', 'evt-fieldnotes', 'Experience', 'blue', 2, 1,
    'usr-fieldnotes-organizer', 'usr-fieldnotes-organizer', '2027-03-01T18:00:00Z', '2027-03-01T18:00:00Z');

UPDATE events
SET agenda_published_at = CASE id
  WHEN 'evt-devflow' THEN '2027-04-18T21:14:00Z'
  ELSE '2027-08-15T18:00:00Z' END
WHERE id IN ('evt-devflow', 'evt-fieldnotes') AND status = 'published';
