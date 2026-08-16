import type {
  AgendaDayCreate,
  AgendaDayUpdate,
  AgendaAutoPlaceRequest,
  AgendaAutoPlaceResponse,
  AgendaPlacementCreate,
  AgendaPlacementUpdate,
  AgendaResponse,
  AgendaPublishResponse,
  AgendaRoomCreate,
  AgendaRoomUpdate,
  AgendaTrackCreate,
  AgendaTrackUpdate,
} from "@confpilot/contracts";
import type { Database, DatabaseResult, DatabaseStatement } from "../../runtime/database";
import { constraintMessage } from "../../runtime/database";

type AgendaEntity = "day" | "event" | "placement" | "room" | "session" | "track";

export class AgendaNotFoundError extends Error {
  constructor(readonly entity: AgendaEntity) {
    super(`${entity} not found`);
  }
}

export class AgendaConflictError extends Error {
  constructor(readonly reason: "AGENDA_HAS_CONFLICTS" | "DAY_REFERENCED" | "IDENTITY" | "NOTHING_TO_PUBLISH" | "NO_PUBLIC_SESSIONS" | "REVISION" | "ROOM_OVERLAP" | "SESSION_ALREADY_SCHEDULED" | "SESSION_NOT_SCHEDULABLE" | "TIME_INVALID") {
    super(reason);
  }
}

interface EventRow {
  slug: string;
  name: string;
  timeZone: string;
  status: AgendaResponse["event"]["status"];
  agendaPublishedAt: string | null;
}

type DayRow = AgendaResponse["days"][number] & { updatedAt: string };

type RoomRow = AgendaResponse["rooms"][number] & { updatedAt: string };

type TrackRow = AgendaResponse["tracks"][number] & { updatedAt: string };

interface SessionRow {
  id: string;
  slug: string;
  title: string;
  track: string;
  format: AgendaResponse["sessions"][number]["format"];
  durationMinutes: number;
  approvalStatus: AgendaResponse["sessions"][number]["approvalStatus"];
  publicationStatus: AgendaResponse["sessions"][number]["publicationStatus"];
  revision: number;
  placementId: string | null;
  dayId: string | null;
  roomId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  placementRevision: number | null;
  placementUpdatedAt: string | null;
}

interface PresenterRow {
  sessionId: string;
  id: string;
  slug: string;
  name: string;
  role: "primary" | "co_presenter";
}

function nextTimestamp(now: string, previous: string) {
  const nowSeconds = Math.floor(Date.parse(now) / 1_000) * 1_000;
  const previousSeconds = Date.parse(previous);
  return new Date(Math.max(nowSeconds, previousSeconds + 1_000)).toISOString().replace(".000Z", "Z");
}

function addMinutes(timestamp: string, minutes: number) {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString().replace(".000Z", "Z");
}

function sameRoom(row: RoomRow, value: AgendaRoomCreate) {
  return row.name === value.name && row.capacity === value.capacity && row.sortOrder === value.sortOrder;
}

function sameTrack(row: TrackRow, value: AgendaTrackCreate) {
  return row.name === value.name && row.color === value.color && row.sortOrder === value.sortOrder;
}

function sameDay(row: DayRow, value: AgendaDayCreate) {
  return row.date === value.date && row.label === value.label && row.opensAt === value.opensAt
    && row.closesAt === value.closesAt && row.slotMinutes === value.slotMinutes;
}

function isConstraint(error: unknown, fragment: string) {
  return constraintMessage(error).toLowerCase().includes(fragment.toLowerCase());
}

function mapWriteError(error: unknown): never {
  if (isConstraint(error, "overlaps an existing room booking")) throw new AgendaConflictError("ROOM_OVERLAP");
  if (isConstraint(error, "unplace sessions first")) throw new AgendaConflictError("DAY_REFERENCED");
  if (isConstraint(error, "slot interval") || isConstraint(error, "operating window")
    || isConstraint(error, "session duration") || isConstraint(error, "date must be inside")
    || isConstraint(error, "placement references must belong")) throw new AgendaConflictError("TIME_INVALID");
  if (isConstraint(error, "UNIQUE constraint failed")) throw new AgendaConflictError("IDENTITY");
  throw error;
}

function requireChanged(result: DatabaseResult) {
  if ((result.meta.changes ?? 0) !== 1) throw new AgendaConflictError("REVISION");
}

export async function getAgenda(database: Database, eventId: string): Promise<AgendaResponse> {
  const [eventResult, dayResult, roomResult, trackResult, sessionResult, presenterResult,
    publicationResult] = await database.batch([
    database.prepare(`SELECT slug, name, time_zone AS timeZone, status,
      agenda_published_at AS agendaPublishedAt FROM events WHERE id = ? LIMIT 1`).bind(eventId),
    database.prepare(`SELECT id, day_number AS dayNumber, date, label, opens_at AS opensAt,
      closes_at AS closesAt, slot_minutes AS slotMinutes, revision, updated_at AS updatedAt
      FROM event_days WHERE event_id = ? ORDER BY day_number, id`).bind(eventId),
    database.prepare(`SELECT id, name, capacity, sort_order AS sortOrder, revision, updated_at AS updatedAt
      FROM rooms WHERE event_id = ? ORDER BY sort_order, name, id`).bind(eventId),
    database.prepare(`SELECT id, name, color, sort_order AS sortOrder, revision, updated_at AS updatedAt
      FROM event_tracks WHERE event_id = ? ORDER BY sort_order, name, id`).bind(eventId),
    database.prepare(`SELECT session.id, session.slug, session.title, session.track, session.format,
      session.duration_minutes AS durationMinutes, session.approval_status AS approvalStatus,
      session.publication_status AS publicationStatus, session.revision,
      placement.id AS placementId, placement.event_day_id AS dayId, placement.room_id AS roomId,
      placement.starts_at AS startsAt, placement.ends_at AS endsAt,
      placement.revision AS placementRevision, placement.updated_at AS placementUpdatedAt
      FROM program_sessions AS session
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = session.event_id
        AND acceptance.program_session_id = session.id
      LEFT JOIN schedule_placements AS placement ON placement.event_id = session.event_id
        AND placement.program_session_id = session.id
      WHERE session.event_id = ? ORDER BY session.title COLLATE NOCASE, session.id`).bind(eventId),
    database.prepare(`SELECT presenter.program_session_id AS sessionId, speaker.id, speaker.slug,
      speaker.name, presenter.role
      FROM session_presenters AS presenter
      INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
        AND speaker.id = presenter.speaker_id
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = presenter.event_id
        AND acceptance.program_session_id = presenter.program_session_id
      WHERE presenter.event_id = ?
      ORDER BY presenter.program_session_id,
        CASE presenter.role WHEN 'primary' THEN 0 ELSE 1 END, speaker.name, speaker.id`).bind(eventId),
    publicationCountsStatement(database, eventId),
  ]);

  const event = eventResult.results[0] as unknown as EventRow | undefined;
  if (!event) throw new AgendaNotFoundError("event");
  const days = dayResult.results as unknown as DayRow[];
  const rooms = roomResult.results as unknown as RoomRow[];
  const tracks = trackResult.results as unknown as TrackRow[];
  const sessionRows = sessionResult.results as unknown as SessionRow[];
  const presenterRows = presenterResult.results as unknown as PresenterRow[];
  const publicationCounts = publicationResult.results[0] as unknown as PublicationCountRow;
  const presentersBySession = new Map<string, PresenterRow[]>();
  for (const presenter of presenterRows) {
    const values = presentersBySession.get(presenter.sessionId) ?? [];
    values.push(presenter);
    presentersBySession.set(presenter.sessionId, values);
  }
  const sessions: AgendaResponse["sessions"] = sessionRows.map((session) => ({
    id: session.id,
    slug: session.slug,
    title: session.title,
    track: session.track,
    format: session.format,
    durationMinutes: session.durationMinutes,
    acceptanceStatus: "accepted",
    approvalStatus: session.approvalStatus,
    publicationStatus: session.publicationStatus,
    revision: session.revision,
    presenters: (presentersBySession.get(session.id) ?? []).map(({ id, slug, name, role }) => ({ id, slug, name, role })),
    placement: session.placementId ? {
      id: session.placementId,
      dayId: session.dayId!,
      roomId: session.roomId!,
      startsAt: session.startsAt!,
      endsAt: session.endsAt!,
      revision: session.placementRevision!,
    } : null,
  }));

  const conflicts: AgendaResponse["conflicts"] = [];
  const placedByPresenter = new Map<string, {
    name: string; sessions: AgendaResponse["sessions"];
  }>();
  for (const session of sessions) {
    if (!session.placement) continue;
    for (const presenter of session.presenters) {
      const entry = placedByPresenter.get(presenter.id) ?? { name: presenter.name, sessions: [] };
      entry.sessions.push(session);
      placedByPresenter.set(presenter.id, entry);
    }
  }
  for (const [speakerId, entry] of placedByPresenter) {
    const ordered = [...entry.sessions].sort((left, right) =>
      left.placement!.startsAt.localeCompare(right.placement!.startsAt)
      || left.id.localeCompare(right.id));
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      const left = ordered[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const right = ordered[rightIndex]!;
        if (right.placement!.startsAt >= left.placement!.endsAt) break;
        const endsAt = left.placement!.endsAt < right.placement!.endsAt
          ? left.placement!.endsAt : right.placement!.endsAt;
        const sessionIds = [left.id, right.id].sort() as [string, string];
        conflicts.push({
          kind: "speaker_overlap",
          speaker: { id: speakerId, name: entry.name },
          sessionIds,
          startsAt: right.placement!.startsAt,
          endsAt,
        });
      }
    }
  }
  conflicts.sort((left, right) => left.startsAt.localeCompare(right.startsAt)
    || left.speaker.name.localeCompare(right.speaker.name)
    || left.sessionIds.join(":").localeCompare(right.sessionIds.join(":")));

  return {
    event,
    publication: {
      publicSessionCount: publicationCounts.publicSessionCount,
      unplacedCount: publicationCounts.unplacedCount,
      contentNotApprovedCount: publicationCounts.contentNotApprovedCount,
      primarySpeakerNotPublicCount: publicationCounts.primarySpeakerNotPublicCount,
      readinessBlockedCount: publicationCounts.readinessBlockedCount,
      awaitingPublicationCount: publicationCounts.awaitingPublicationCount,
    },
    days: days.map(({ updatedAt: _updatedAt, ...day }) => day),
    rooms: rooms.map(({ updatedAt: _updatedAt, ...room }) => room),
    tracks: tracks.map(({ updatedAt: _updatedAt, ...track }) => track),
    sessions,
    conflicts,
  };
}

async function roomById(database: Database, eventId: string, roomId: string) {
  return database.prepare(`SELECT id, name, capacity, sort_order AS sortOrder, revision,
    updated_at AS updatedAt FROM rooms WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, roomId).first<RoomRow>();
}

async function roomByName(database: Database, eventId: string, name: string) {
  return database.prepare(`SELECT id, name, capacity, sort_order AS sortOrder, revision,
    updated_at AS updatedAt FROM rooms WHERE event_id = ? AND lower(trim(name)) = lower(trim(?)) LIMIT 1`)
    .bind(eventId, name).first<RoomRow>();
}

export async function createAgendaRoom(database: Database, input: {
  eventId: string; actorUserId: string; value: AgendaRoomCreate; now: string;
}) {
  const existing = await roomByName(database, input.eventId, input.value.name);
  if (existing) {
    if (sameRoom(existing, input.value)) return existing;
    throw new AgendaConflictError("IDENTITY");
  }
  const id = crypto.randomUUID();
  try {
    await database.prepare(`INSERT INTO rooms (id, event_id, name, capacity, sort_order, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(id, input.eventId, input.value.name, input.value.capacity, input.value.sortOrder,
        input.actorUserId, input.actorUserId, input.now, input.now).run();
  } catch (error) {
    const raced = await roomByName(database, input.eventId, input.value.name);
    if (raced && sameRoom(raced, input.value)) return raced;
    return mapWriteError(error);
  }
  return (await roomById(database, input.eventId, id))!;
}

export async function updateAgendaRoom(database: Database, input: {
  eventId: string; roomId: string; actorUserId: string; value: AgendaRoomUpdate; now: string;
}) {
  const existing = await roomById(database, input.eventId, input.roomId);
  if (!existing) throw new AgendaNotFoundError("room");
  const value = { name: input.value.name, capacity: input.value.capacity, sortOrder: input.value.sortOrder };
  if (sameRoom(existing, value)) return existing;
  if (existing.revision !== input.value.revision) throw new AgendaConflictError("REVISION");
  try {
    const result = await database.prepare(`UPDATE rooms SET name = ?, capacity = ?, sort_order = ?, revision = revision + 1,
      updated_by_user_id = ?, updated_at = ? WHERE event_id = ? AND id = ? AND revision = ?`)
      .bind(value.name, value.capacity, value.sortOrder, input.actorUserId,
        nextTimestamp(input.now, existing.updatedAt), input.eventId, input.roomId, input.value.revision).run();
    requireChanged(result);
  } catch (error) { return mapWriteError(error); }
  return (await roomById(database, input.eventId, input.roomId))!;
}

async function trackById(database: Database, eventId: string, trackId: string) {
  return database.prepare(`SELECT id, name, color, sort_order AS sortOrder, revision,
    updated_at AS updatedAt FROM event_tracks WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, trackId).first<TrackRow>();
}

async function trackByName(database: Database, eventId: string, name: string) {
  return database.prepare(`SELECT id, name, color, sort_order AS sortOrder, revision,
    updated_at AS updatedAt FROM event_tracks WHERE event_id = ? AND lower(name) = lower(?) LIMIT 1`)
    .bind(eventId, name).first<TrackRow>();
}

export async function createAgendaTrack(database: Database, input: {
  eventId: string; actorUserId: string; value: AgendaTrackCreate; now: string;
}) {
  const existing = await trackByName(database, input.eventId, input.value.name);
  if (existing) {
    if (sameTrack(existing, input.value)) return existing;
    throw new AgendaConflictError("IDENTITY");
  }
  const id = crypto.randomUUID();
  try {
    await database.prepare(`INSERT INTO event_tracks (id, event_id, name, color, sort_order, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(id, input.eventId, input.value.name, input.value.color, input.value.sortOrder,
        input.actorUserId, input.actorUserId, input.now, input.now).run();
  } catch (error) {
    const raced = await trackByName(database, input.eventId, input.value.name);
    if (raced && sameTrack(raced, input.value)) return raced;
    return mapWriteError(error);
  }
  return (await trackById(database, input.eventId, id))!;
}

export async function updateAgendaTrack(database: Database, input: {
  eventId: string; trackId: string; actorUserId: string; value: AgendaTrackUpdate; now: string;
}) {
  const existing = await trackById(database, input.eventId, input.trackId);
  if (!existing) throw new AgendaNotFoundError("track");
  if (existing.color === input.value.color && existing.sortOrder === input.value.sortOrder) return existing;
  if (existing.revision !== input.value.revision) throw new AgendaConflictError("REVISION");
  try {
    const result = await database.prepare(`UPDATE event_tracks SET color = ?, sort_order = ?, revision = revision + 1,
      updated_by_user_id = ?, updated_at = ? WHERE event_id = ? AND id = ? AND revision = ?`)
      .bind(input.value.color, input.value.sortOrder, input.actorUserId,
        nextTimestamp(input.now, existing.updatedAt), input.eventId, input.trackId, input.value.revision).run();
    requireChanged(result);
  } catch (error) { return mapWriteError(error); }
  return (await trackById(database, input.eventId, input.trackId))!;
}

async function dayById(database: Database, eventId: string, dayId: string) {
  return database.prepare(`SELECT id, day_number AS dayNumber, date, label, opens_at AS opensAt,
    closes_at AS closesAt, slot_minutes AS slotMinutes, revision, updated_at AS updatedAt
    FROM event_days WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, dayId).first<DayRow>();
}

async function dayByDate(database: Database, eventId: string, date: string) {
  return database.prepare(`SELECT id, day_number AS dayNumber, date, label, opens_at AS opensAt,
    closes_at AS closesAt, slot_minutes AS slotMinutes, revision, updated_at AS updatedAt
    FROM event_days WHERE event_id = ? AND date = ? LIMIT 1`)
    .bind(eventId, date).first<DayRow>();
}

export async function createAgendaDay(database: Database, input: {
  eventId: string; actorUserId: string; value: AgendaDayCreate; now: string;
}) {
  const existing = await dayByDate(database, input.eventId, input.value.date);
  if (existing) {
    if (sameDay(existing, input.value)) return existing;
    throw new AgendaConflictError("IDENTITY");
  }
  const id = crypto.randomUUID();
  try {
    await database.prepare(`INSERT INTO event_days (id, event_id, day_number, date, label, opens_at,
      closes_at, slot_minutes, revision, created_by_user_id, updated_by_user_id, created_at, updated_at)
      SELECT ?, ?, COALESCE(MAX(day_number), 0) + 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
      FROM event_days WHERE event_id = ?`)
      .bind(id, input.eventId, input.value.date, input.value.label,
        input.value.opensAt, input.value.closesAt, input.value.slotMinutes,
        input.actorUserId, input.actorUserId, input.now, input.now, input.eventId).run();
  } catch (error) {
    const raced = await dayByDate(database, input.eventId, input.value.date);
    if (raced && sameDay(raced, input.value)) return raced;
    return mapWriteError(error);
  }
  return (await dayById(database, input.eventId, id))!;
}

export async function updateAgendaDay(database: Database, input: {
  eventId: string; dayId: string; actorUserId: string; value: AgendaDayUpdate; now: string;
}) {
  const existing = await dayById(database, input.eventId, input.dayId);
  if (!existing) throw new AgendaNotFoundError("day");
  const value = { date: input.value.date, label: input.value.label, opensAt: input.value.opensAt,
    closesAt: input.value.closesAt, slotMinutes: input.value.slotMinutes };
  if (sameDay(existing, value)) return existing;
  if (existing.revision !== input.value.revision) throw new AgendaConflictError("REVISION");
  try {
    const result = await database.prepare(`UPDATE event_days SET date = ?, label = ?, opens_at = ?, closes_at = ?,
      slot_minutes = ?, revision = revision + 1, updated_by_user_id = ?, updated_at = ?
      WHERE event_id = ? AND id = ? AND revision = ?`)
      .bind(value.date, value.label, value.opensAt, value.closesAt, value.slotMinutes,
        input.actorUserId, nextTimestamp(input.now, existing.updatedAt), input.eventId,
        input.dayId, input.value.revision).run();
    requireChanged(result);
  } catch (error) { return mapWriteError(error); }
  return (await dayById(database, input.eventId, input.dayId))!;
}

interface PlacementRow {
  id: string;
  sessionId: string;
  dayId: string;
  roomId: string;
  startsAt: string;
  endsAt: string;
  revision: number;
  updatedAt: string;
}

async function placementById(database: Database, eventId: string, placementId: string) {
  return database.prepare(`SELECT id, program_session_id AS sessionId, event_day_id AS dayId,
    room_id AS roomId, starts_at AS startsAt, ends_at AS endsAt, revision, updated_at AS updatedAt
    FROM schedule_placements WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, placementId).first<PlacementRow>();
}

async function placementBySession(database: Database, eventId: string, sessionId: string) {
  return database.prepare(`SELECT id, program_session_id AS sessionId, event_day_id AS dayId,
    room_id AS roomId, starts_at AS startsAt, ends_at AS endsAt, revision, updated_at AS updatedAt
    FROM schedule_placements WHERE event_id = ? AND program_session_id = ? LIMIT 1`)
    .bind(eventId, sessionId).first<PlacementRow>();
}

async function acceptedDuration(database: Database, eventId: string, sessionId: string) {
  return database.prepare(`SELECT session.duration_minutes AS durationMinutes
    FROM program_sessions AS session INNER JOIN acceptances AS acceptance
      ON acceptance.event_id = session.event_id AND acceptance.program_session_id = session.id
    WHERE session.event_id = ? AND session.id = ? LIMIT 1`)
    .bind(eventId, sessionId).first<{ durationMinutes: number }>();
}

function samePlacement(row: PlacementRow, value: { dayId: string; roomId: string; startsAt: string }, endsAt: string) {
  return row.dayId === value.dayId && row.roomId === value.roomId
    && row.startsAt === value.startsAt && row.endsAt === endsAt;
}

export async function createAgendaPlacement(database: Database, input: {
  eventId: string; actorUserId: string; value: AgendaPlacementCreate; now: string;
}) {
  const duration = await acceptedDuration(database, input.eventId, input.value.sessionId);
  if (!duration) throw new AgendaConflictError("SESSION_NOT_SCHEDULABLE");
  const endsAt = addMinutes(input.value.startsAt, duration.durationMinutes);
  const existing = await placementBySession(database, input.eventId, input.value.sessionId);
  if (existing) {
    if (samePlacement(existing, input.value, endsAt)) return existing;
    throw new AgendaConflictError("SESSION_ALREADY_SCHEDULED");
  }
  const id = crypto.randomUUID();
  try {
    await database.prepare(`INSERT INTO schedule_placements (id, event_id, program_session_id,
      event_day_id, room_id, starts_at, ends_at, revision, created_by_user_id,
      updated_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .bind(id, input.eventId, input.value.sessionId, input.value.dayId, input.value.roomId,
        input.value.startsAt, endsAt, input.actorUserId, input.actorUserId, input.now, input.now).run();
  } catch (error) {
    const raced = await placementBySession(database, input.eventId, input.value.sessionId);
    if (raced && samePlacement(raced, input.value, endsAt)) return raced;
    return mapWriteError(error);
  }
  return (await placementById(database, input.eventId, id))!;
}

export async function updateAgendaPlacement(database: Database, input: {
  eventId: string; placementId: string; actorUserId: string; value: AgendaPlacementUpdate; now: string;
}) {
  const existing = await placementById(database, input.eventId, input.placementId);
  if (!existing) throw new AgendaNotFoundError("placement");
  const duration = await acceptedDuration(database, input.eventId, existing.sessionId);
  if (!duration) throw new AgendaConflictError("SESSION_NOT_SCHEDULABLE");
  const endsAt = addMinutes(input.value.startsAt, duration.durationMinutes);
  if (samePlacement(existing, input.value, endsAt)) return existing;
  if (existing.revision !== input.value.revision) throw new AgendaConflictError("REVISION");
  try {
    const result = await database.prepare(`UPDATE schedule_placements SET event_day_id = ?, room_id = ?,
      starts_at = ?, ends_at = ?, revision = revision + 1, updated_by_user_id = ?, updated_at = ?
      WHERE event_id = ? AND id = ? AND revision = ?`)
      .bind(input.value.dayId, input.value.roomId, input.value.startsAt, endsAt,
        input.actorUserId, nextTimestamp(input.now, existing.updatedAt), input.eventId,
        input.placementId, input.value.revision).run();
    requireChanged(result);
  } catch (error) { return mapWriteError(error); }
  return (await placementById(database, input.eventId, input.placementId))!;
}

export async function deleteAgendaPlacement(database: Database, input: {
  eventId: string; placementId: string; expectedRevision: number; now: string;
}) {
  const existing = await placementById(database, input.eventId, input.placementId);
  if (!existing) throw new AgendaNotFoundError("placement");
  if (existing.revision !== input.expectedRevision) throw new AgendaConflictError("REVISION");
  await database.batch([
    database.prepare(`DELETE FROM schedule_placements
      WHERE event_id = ? AND id = ? AND revision = ?`)
      .bind(input.eventId, input.placementId, input.expectedRevision),
    database.prepare(`UPDATE program_sessions SET publication_status = 'ready',
      revision = revision + 1,
      updated_at = CASE WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second') ELSE ? END
      WHERE event_id = ? AND id = ? AND publication_status = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM schedule_placements AS remaining
          WHERE remaining.event_id = program_sessions.event_id
            AND remaining.program_session_id = program_sessions.id
        )`)
      .bind(input.now, input.now, input.eventId, existing.sessionId),
  ]);
  if (await placementById(database, input.eventId, input.placementId)) {
    throw new AgendaConflictError("REVISION");
  }
}

function autoPlaceStatement(database: Database, input: {
  eventId: string; sessionId: string; placementId: string; actorUserId: string; now: string;
}) {
  return database.prepare(`WITH RECURSIVE target_session AS (
      SELECT session.id, session.duration_minutes
      FROM program_sessions AS session
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = session.event_id
        AND acceptance.program_session_id = session.id
      WHERE session.event_id = ? AND session.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM schedule_placements AS existing
          WHERE existing.event_id = session.event_id AND existing.program_session_id = session.id
        )
    ), candidate_slots (
      day_id, day_number, starts_at, closes_at, slot_minutes, duration_minutes
    ) AS (
      SELECT day.id, day.day_number, day.opens_at, day.closes_at, day.slot_minutes,
        target.duration_minutes
      FROM event_days AS day CROSS JOIN target_session AS target
      WHERE day.event_id = ?
        AND strftime('%Y-%m-%dT%H:%M:%SZ', day.opens_at,
          '+' || target.duration_minutes || ' minutes') <= day.closes_at
      UNION ALL
      SELECT day_id, day_number,
        strftime('%Y-%m-%dT%H:%M:%SZ', starts_at, '+' || slot_minutes || ' minutes'),
        closes_at, slot_minutes, duration_minutes
      FROM candidate_slots
      WHERE strftime('%Y-%m-%dT%H:%M:%SZ', starts_at,
        '+' || slot_minutes || ' minutes', '+' || duration_minutes || ' minutes') <= closes_at
    ), speaker_available AS (
      SELECT slot.day_id, slot.day_number, slot.starts_at,
        strftime('%Y-%m-%dT%H:%M:%SZ', slot.starts_at,
          '+' || slot.duration_minutes || ' minutes') AS ends_at
      FROM candidate_slots AS slot
      WHERE NOT EXISTS (
          SELECT 1
          FROM schedule_placements AS existing
          INNER JOIN session_presenters AS existing_presenter
            ON existing_presenter.event_id = existing.event_id
            AND existing_presenter.program_session_id = existing.program_session_id
          INNER JOIN session_presenters AS target_presenter
            ON target_presenter.event_id = existing_presenter.event_id
            AND target_presenter.speaker_id = existing_presenter.speaker_id
            AND target_presenter.program_session_id = ?
          WHERE existing.event_id = ?
            AND slot.starts_at < existing.ends_at
            AND existing.starts_at < strftime('%Y-%m-%dT%H:%M:%SZ', slot.starts_at,
              '+' || slot.duration_minutes || ' minutes')
        )
    ), room_candidates AS (
      SELECT slot.day_id, slot.day_number, slot.starts_at, slot.ends_at,
        (SELECT room.id FROM rooms AS room
          WHERE room.event_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM schedule_placements AS existing
              WHERE existing.event_id = ? AND existing.room_id = room.id
                AND slot.starts_at < existing.ends_at AND existing.starts_at < slot.ends_at
            )
          ORDER BY room.sort_order, room.id LIMIT 1) AS room_id
      FROM speaker_available AS slot
    ), available AS (
      SELECT day_id, room_id, starts_at, ends_at
      FROM room_candidates WHERE room_id IS NOT NULL
      ORDER BY day_number, starts_at, room_id
      LIMIT 1
    )
    INSERT INTO schedule_placements (
      id, event_id, program_session_id, event_day_id, room_id, starts_at, ends_at,
      revision, created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    SELECT ?, ?, ?, available.day_id, available.room_id, available.starts_at, available.ends_at,
      1, ?, ?, ?, ? FROM available`)
    .bind(input.eventId, input.sessionId, input.eventId, input.sessionId, input.eventId,
      input.eventId, input.eventId, input.placementId, input.eventId, input.sessionId,
      input.actorUserId, input.actorUserId, input.now, input.now);
}

export async function autoPlaceAgenda(database: Database, input: {
  eventId: string; actorUserId: string; value: AgendaAutoPlaceRequest; now: string;
}): Promise<AgendaAutoPlaceResponse> {
  const before = await getAgenda(database, input.eventId);
  const requestedIds = input.value.sessionIds.length > 0
    ? input.value.sessionIds
    : before.sessions.filter((session) => !session.placement).map((session) => session.id).sort();
  const sessionById = new Map(before.sessions.map((session) => [session.id, session]));
  const generatedIds = new Map<string, string>();
  const statements: DatabaseStatement[] = [];
  for (const sessionId of requestedIds) {
    const session = sessionById.get(sessionId);
    if (!session || session.placement) continue;
    const placementId = crypto.randomUUID();
    generatedIds.set(sessionId, placementId);
    statements.push(autoPlaceStatement(database, { eventId: input.eventId, sessionId,
      placementId, actorUserId: input.actorUserId, now: input.now }));
  }
  if (statements.length > 0) await database.batch(statements);
  const agenda = await getAgenda(database, input.eventId);
  const afterById = new Map(agenda.sessions.map((session) => [session.id, session]));
  const results: AgendaAutoPlaceResponse["results"] = requestedIds.map((sessionId) => {
    const beforeSession = sessionById.get(sessionId);
    if (!beforeSession) return { sessionId, status: "unplaced", reason: "SESSION_NOT_ACCEPTED" };
    if (beforeSession.placement) return { sessionId, status: "unplaced", reason: "SESSION_ALREADY_PLACED" };
    const placement = afterById.get(sessionId)?.placement;
    if (placement && placement.id === generatedIds.get(sessionId)) {
      return { sessionId, status: "placed", placement };
    }
    if (placement) return { sessionId, status: "unplaced", reason: "SESSION_ALREADY_PLACED" };
    return { sessionId, status: "unplaced", reason: "NO_AVAILABLE_SLOT" };
  });
  return { agenda, results };
}

const NO_SPEAKER_CONFLICT = `NOT EXISTS (
  SELECT 1
  FROM schedule_placements AS left_placement
  INNER JOIN schedule_placements AS right_placement
    ON right_placement.event_id = left_placement.event_id
    AND right_placement.id > left_placement.id
    AND left_placement.starts_at < right_placement.ends_at
    AND right_placement.starts_at < left_placement.ends_at
  INNER JOIN session_presenters AS left_presenter
    ON left_presenter.event_id = left_placement.event_id
    AND left_presenter.program_session_id = left_placement.program_session_id
  INNER JOIN session_presenters AS right_presenter
    ON right_presenter.event_id = right_placement.event_id
    AND right_presenter.program_session_id = right_placement.program_session_id
    AND right_presenter.speaker_id = left_presenter.speaker_id
  WHERE left_placement.event_id = ?
)`;

function publicEligibleSession(additionalPredicate = "") {
  return `EXISTS (
  SELECT 1
  FROM program_sessions AS eligible_session
  INNER JOIN acceptances AS eligible_acceptance
    ON eligible_acceptance.event_id = eligible_session.event_id
    AND eligible_acceptance.program_session_id = eligible_session.id
  INNER JOIN schedule_placements AS eligible_placement
    ON eligible_placement.event_id = eligible_session.event_id
    AND eligible_placement.program_session_id = eligible_session.id
  INNER JOIN session_presenters AS eligible_presenter
    ON eligible_presenter.event_id = eligible_session.event_id
    AND eligible_presenter.program_session_id = eligible_session.id
    AND eligible_presenter.role = 'primary'
  INNER JOIN speakers AS eligible_speaker
    ON eligible_speaker.event_id = eligible_presenter.event_id
    AND eligible_speaker.id = eligible_presenter.speaker_id
  WHERE eligible_session.event_id = events.id
    AND eligible_session.approval_status = 'approved'
    AND eligible_speaker.public_visibility = 'published'
    AND EXISTS (SELECT 1 FROM session_deliverable_readiness AS readiness
      WHERE readiness.event_id = eligible_session.event_id
        AND readiness.program_session_id = eligible_session.id
        AND readiness.deliverables_status = 'ready')
    AND NOT EXISTS (SELECT 1 FROM speaker_tasks AS task
      WHERE task.event_id = eligible_session.event_id
        AND task.program_session_id = eligible_session.id
        AND task.state = 'open')
    AND NOT EXISTS (SELECT 1 FROM session_presenters AS presenter
      INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
        AND speaker.id = presenter.speaker_id
      WHERE presenter.event_id = eligible_session.event_id
        AND presenter.program_session_id = eligible_session.id
        AND (speaker.workflow_status != 'confirmed'
          OR speaker.profile_status != 'ready'
          OR speaker.agreement_status != 'signed'))
    ${additionalPredicate}
)`;
}

const PUBLIC_ELIGIBLE_SESSION = publicEligibleSession();
const PENDING_PUBLIC_SESSION = publicEligibleSession(
  "AND eligible_session.publication_status != 'published'",
);

interface PublicationCountRow {
  eventStatus: AgendaResponse["event"]["status"];
  agendaPublishedAt: string | null;
  publicSessionCount: number;
  unplacedCount: number;
  contentNotApprovedCount: number;
  primarySpeakerNotPublicCount: number;
  readinessBlockedCount: number;
  awaitingPublicationCount: number;
}

function publicationCountsStatement(database: Database, eventId: string) {
  return database.prepare(`WITH accepted_sessions AS (
      SELECT session.id, session.approval_status AS approval_status,
        session.publication_status AS publication_status,
        EXISTS (SELECT 1 FROM session_deliverable_readiness AS readiness
          WHERE readiness.event_id = session.event_id
            AND readiness.program_session_id = session.id
            AND readiness.deliverables_status = 'ready') AS deliverables_ready,
        NOT EXISTS (SELECT 1 FROM speaker_tasks AS task
          WHERE task.event_id = session.event_id
            AND task.program_session_id = session.id
            AND task.state = 'open') AS tasks_ready,
        NOT EXISTS (SELECT 1 FROM session_presenters AS presenter
          INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
            AND speaker.id = presenter.speaker_id
          WHERE presenter.event_id = session.event_id
            AND presenter.program_session_id = session.id
            AND (speaker.workflow_status != 'confirmed'
              OR speaker.profile_status != 'ready'
              OR speaker.agreement_status != 'signed')) AS presenters_ready,
        EXISTS (SELECT 1 FROM schedule_placements AS placement
          WHERE placement.event_id = session.event_id
            AND placement.program_session_id = session.id) AS placed,
        EXISTS (SELECT 1 FROM session_presenters AS presenter
          INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
            AND speaker.id = presenter.speaker_id
          WHERE presenter.event_id = session.event_id
            AND presenter.program_session_id = session.id
            AND presenter.role = 'primary'
            AND speaker.public_visibility = 'published') AS primary_public
      FROM program_sessions AS session
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = session.event_id
        AND acceptance.program_session_id = session.id
      WHERE session.event_id = ?
    )
    SELECT
      event.status AS eventStatus,
      event.agenda_published_at AS agendaPublishedAt,
      CASE WHEN event.status = 'published' THEN COALESCE(SUM(CASE
        WHEN accepted.placed = 1 AND accepted.approval_status = 'approved'
          AND accepted.primary_public = 1 AND accepted.presenters_ready = 1
          AND accepted.tasks_ready = 1 AND accepted.deliverables_ready = 1
          AND accepted.publication_status = 'published'
        THEN 1 ELSE 0 END), 0) ELSE 0 END AS publicSessionCount,
      COALESCE(SUM(CASE WHEN accepted.placed = 0 THEN 1 ELSE 0 END), 0) AS unplacedCount,
      COALESCE(SUM(CASE WHEN accepted.placed = 1
        AND accepted.approval_status != 'approved' THEN 1 ELSE 0 END), 0) AS contentNotApprovedCount,
      COALESCE(SUM(CASE WHEN accepted.placed = 1
        AND accepted.approval_status = 'approved' AND accepted.primary_public = 0
        THEN 1 ELSE 0 END), 0) AS primarySpeakerNotPublicCount,
      COALESCE(SUM(CASE WHEN accepted.placed = 1
        AND accepted.approval_status = 'approved' AND accepted.primary_public = 1
        AND (accepted.presenters_ready = 0 OR accepted.tasks_ready = 0
          OR accepted.deliverables_ready = 0)
        THEN 1 ELSE 0 END), 0) AS readinessBlockedCount,
      COALESCE(SUM(CASE WHEN accepted.placed = 1
        AND accepted.approval_status = 'approved' AND accepted.primary_public = 1
        AND accepted.presenters_ready = 1 AND accepted.tasks_ready = 1
        AND accepted.deliverables_ready = 1
        AND (event.status != 'published' OR accepted.publication_status != 'published')
        THEN 1 ELSE 0 END), 0) AS awaitingPublicationCount
    FROM events AS event LEFT JOIN accepted_sessions AS accepted ON 1 = 1
    WHERE event.id = ? GROUP BY event.id, event.status, event.agenda_published_at`).bind(eventId, eventId);
}

export async function publishAgenda(database: Database, input: {
  eventId: string; now: string;
}): Promise<AgendaPublishResponse> {
  const before = await getAgenda(database, input.eventId);
  if (!before.sessions.some((session) => session.placement)) throw new AgendaConflictError("NOTHING_TO_PUBLISH");
  if (before.conflicts.length > 0) throw new AgendaConflictError("AGENDA_HAS_CONFLICTS");
  const sessionTimestamp = `CASE WHEN ? > updated_at THEN ?
    ELSE strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second') END`;
  const [beforeCountsResult, , , afterCountsResult] = await database.batch([
    publicationCountsStatement(database, input.eventId),
    database.prepare(`UPDATE events SET status = 'published',
      agenda_published_at = CASE
        WHEN status != 'published' OR agenda_published_at IS NULL OR ${PENDING_PUBLIC_SESSION}
        THEN CASE
          WHEN agenda_published_at IS NULL OR ? > agenda_published_at THEN ?
          ELSE strftime('%Y-%m-%dT%H:%M:%SZ', agenda_published_at, '+1 second')
        END
        ELSE agenda_published_at
      END
      WHERE id = ? AND ${PUBLIC_ELIGIBLE_SESSION}
        AND ${NO_SPEAKER_CONFLICT}`)
      .bind(input.now, input.now, input.eventId, input.eventId),
    database.prepare(`UPDATE program_sessions
      SET publication_status = 'published', revision = revision + 1,
        updated_at = ${sessionTimestamp}
      WHERE event_id = ? AND approval_status = 'approved'
        AND publication_status != 'published'
        AND EXISTS (SELECT 1 FROM acceptances AS acceptance
          WHERE acceptance.event_id = program_sessions.event_id
            AND acceptance.program_session_id = program_sessions.id)
        AND EXISTS (SELECT 1 FROM schedule_placements AS placement
          WHERE placement.event_id = program_sessions.event_id
            AND placement.program_session_id = program_sessions.id)
        AND EXISTS (SELECT 1 FROM session_presenters AS presenter
          INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
            AND speaker.id = presenter.speaker_id
          WHERE presenter.event_id = program_sessions.event_id
            AND presenter.program_session_id = program_sessions.id
            AND presenter.role = 'primary'
            AND speaker.public_visibility = 'published')
        AND EXISTS (SELECT 1 FROM session_deliverable_readiness AS readiness
          WHERE readiness.event_id = program_sessions.event_id
            AND readiness.program_session_id = program_sessions.id
            AND readiness.deliverables_status = 'ready')
        AND NOT EXISTS (SELECT 1 FROM speaker_tasks AS task
          WHERE task.event_id = program_sessions.event_id
            AND task.program_session_id = program_sessions.id
            AND task.state = 'open')
        AND NOT EXISTS (SELECT 1 FROM session_presenters AS presenter
          INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
            AND speaker.id = presenter.speaker_id
          WHERE presenter.event_id = program_sessions.event_id
            AND presenter.program_session_id = program_sessions.id
            AND (speaker.workflow_status != 'confirmed'
              OR speaker.profile_status != 'ready'
              OR speaker.agreement_status != 'signed'))
        AND ${NO_SPEAKER_CONFLICT}`)
      .bind(input.now, input.now, input.eventId, input.eventId),
    publicationCountsStatement(database, input.eventId),
  ]);
  const beforeCounts = beforeCountsResult.results[0] as unknown as PublicationCountRow | undefined;
  const afterCounts = afterCountsResult.results[0] as unknown as PublicationCountRow | undefined;
  if (!beforeCounts || !afterCounts) throw new AgendaNotFoundError("event");
  const agenda = await getAgenda(database, input.eventId);
  if (agenda.conflicts.length > 0) throw new AgendaConflictError("AGENDA_HAS_CONFLICTS");
  if (afterCounts.publicSessionCount === 0) {
    throw new AgendaConflictError("NO_PUBLIC_SESSIONS");
  }
  if (agenda.event.status !== "published" || !agenda.event.agendaPublishedAt) {
    throw new AgendaConflictError("NO_PUBLIC_SESSIONS");
  }
  const newlyPublicSessionCount = Math.max(0,
    afterCounts.publicSessionCount - beforeCounts.publicSessionCount);
  const publicationChanged = newlyPublicSessionCount > 0
    || beforeCounts.eventStatus !== "published"
    || beforeCounts.agendaPublishedAt === null;
  const skipped: AgendaPublishResponse["publication"]["skipped"] = [];
  if (afterCounts.unplacedCount > 0) skipped.push({ reason: "UNPLACED", count: afterCounts.unplacedCount });
  if (afterCounts.contentNotApprovedCount > 0) {
    skipped.push({ reason: "CONTENT_NOT_APPROVED", count: afterCounts.contentNotApprovedCount });
  }
  if (afterCounts.primarySpeakerNotPublicCount > 0) {
    skipped.push({ reason: "PRIMARY_SPEAKER_NOT_PUBLIC", count: afterCounts.primarySpeakerNotPublicCount });
  }
  if (afterCounts.readinessBlockedCount > 0) {
    skipped.push({ reason: "READINESS_BLOCKED", count: afterCounts.readinessBlockedCount });
  }
  return {
    agenda,
    publication: {
      outcome: publicationChanged ? "changed" : "unchanged",
      newlyPublicSessionCount,
      publicSessionCount: afterCounts.publicSessionCount,
      skipped,
    },
    publicPaths: {
      program: "/program",
      calendar: `/api/program.ics?event=${agenda.event.slug}`,
    },
  };
}
