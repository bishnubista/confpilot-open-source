import {
  organizerContentListResponseSchema,
  organizerSpeakerRosterResponseSchema,
  speakerContentWorkspaceResponseSchema,
  speakerProfileHistorySnapshotSchema,
  speakerProfileResponseSchema,
  type ContentCommentResponse,
  type ContentCommentCreate,
  type ContentReviewCreate,
  type ContentReviewResponse,
  type DeliverableRequestCreate,
  type DeliverableRequestResponse,
  type DeliverableRequestUpdate,
  type DeliverableVersionResponse,
  type OrganizerSpeakerTaskUpdate,
  type OrganizerContentListResponse,
  type OrganizerSpeakerRosterResponse,
  type SessionContentHistoryResponse,
  type SessionContentUpdate,
  type SessionApprovalUpdate,
  type SpeakerContentHistoryResponse,
  type SpeakerContentWorkspaceResponse,
  type SpeakerProfileResponse,
  type SpeakerProfileHistorySnapshot,
  type SpeakerOwnedProfileUpdate,
  type SpeakerProfileUpdate,
  type SpeakerTaskBulkCreate,
  type SpeakerTaskResponse,
  type SpeakerTaskUpdate,
  type SpeakerVisibilityUpdate,
  type SpeakerWorkflowUpdate,
} from "@confpilot/contracts";
import type { DeliverableArchiveSource } from "./deliverables-archive";
import type { Database, DatabaseResult } from "../../runtime/database";
import { constraintMessage } from "../../runtime/database";

interface EventRow { id: string; slug: string; name: string }
interface SpeakerRow {
  id: string; userId: string | null; slug: string; name: string; contactEmail: string | null;
  title: string; company: string; bio: string; socialUrlsJson: string; travelPreferences: string;
  workflowStatus: SpeakerProfileResponse["workflowStatus"];
  profileStatus: SpeakerProfileResponse["profileStatus"];
  agreementStatus: SpeakerProfileResponse["agreementStatus"];
  publicVisibility: SpeakerProfileResponse["publicVisibility"];
  headshotObjectKey: string | null; headshotOriginalFilename: string | null;
  headshotContentType: SpeakerProfileResponse["headshot"] extends infer H
    ? H extends { contentType: infer C } ? C : never : never;
  headshotByteSize: number | null; headshotSha256: string | null; headshotUploadedAt: string | null;
  revision: number; updatedAt: string;
}
interface SessionRow {
  id: string; slug: string; title: string; abstract: string; track: string;
  format: "keynote" | "talk" | "lightning" | "workshop" | "panel";
  durationMinutes: number; deliverablesStatus: "missing" | "submitted" | "ready";
  approvalStatus: "pending" | "changes_requested" | "approved"; revision: number;
  room: string | null; startsAt: string | null; endsAt: string | null;
}
interface PresenterRow { sessionId: string; speakerId: string; role: "primary" | "co_presenter" }
interface TaskRow {
  id: string; sessionId: string; speakerId: string; taskKey: string; label: string;
  state: "open" | "complete" | "waived"; dueAt: string | null; completedAt: string | null;
  revision: number; updatedAt: string;
}
interface RequestRow {
  id: string; sessionId: string; requestKey: string; requestType: "presentation";
  label: string; instructions: string; dueAt: string; allowedContentTypesJson: string;
  maxBytes: number; required: number; active: number; revision: number; createdAt: string; updatedAt: string;
}
interface VersionRow {
  id: string; requestId: string; sessionId: string; requestType: "presentation";
  versionNumber: number; originalFilename: string; objectKey: string;
  contentType: DeliverableVersionResponse["contentType"]; byteSize: number; sha256: string; note: string;
  uploaderSpeakerId: string; uploaderName: string; uploadedAt: string;
}
interface CommentRow {
  id: string; sessionId: string; versionId: string; authorSpeakerId: string | null;
  speakerName: string | null; organizerName: string | null; body: string; createdAt: string;
}
interface ReviewRow {
  id: string; sessionId: string; versionId: string; outcome: "changes_requested" | "approved";
  comment: string; reviewerName: string; reviewedAt: string;
}
interface HistoryRow {
  id: string; sessionId: string; action: "updated" | "restored"; title: string; abstract: string;
  track: string; format: SessionRow["format"]; durationMinutes: number; changeNote: string;
  actorName: string; createdAt: string;
}
interface SpeakerHistoryRow {
  id: string; speakerId: string; action: "updated" | "headshot_uploaded" | "restored";
  profileJson: string; changeNote: string; actorName: string; createdAt: string;
}

export class SpeakerContentNotFoundError extends Error {}
export class SpeakerContentConflictError extends Error {}
export type SpeakerContentNotAllowedReason =
  | "PROFILE_NOT_READY"
  | "TASK_WAIVED"
  | "NO_CHANGES"
  | "RESTORE_NOT_ALLOWED";
export class SpeakerContentNotAllowedError extends Error {
  constructor(public readonly reason: SpeakerContentNotAllowedReason) {
    super(reason);
  }
}
export class SpeakerContentApprovalBlockedError extends Error {}
export class SpeakerContentDataIntegrityError extends Error {}
export class SpeakerContentCanonicalUploadError extends Error {
  constructor(
    public readonly canonical: VersionRow,
    public readonly semanticMatch: boolean,
  ) {
    super("An upload with this idempotency key already exists.");
  }
}

export const MONOTONIC_UPDATED_AT_SQL = `CASE
  WHEN julianday(updated_at) >= julianday(?)
    THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
  ELSE ? END`;

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K) {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const values = grouped.get(key(row)) ?? [];
    values.push(row);
    grouped.set(key(row), values);
  }
  return grouped;
}

function parseObject(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function parseArray(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Expected a string array");
  }
  return parsed;
}

type ProjectionLane = "speaker" | "organizer";

function profileProjection(
  row: SpeakerRow,
  eventSlug: string,
  lane: ProjectionLane = "organizer",
): SpeakerProfileResponse {
  const social = parseObject(row.socialUrlsJson);
  const headshotComplete = row.headshotObjectKey !== null
    && row.headshotOriginalFilename !== null
    && row.headshotContentType !== null
    && row.headshotByteSize !== null
    && row.headshotSha256 !== null
    && row.headshotUploadedAt !== null;
  return {
    id: row.id,
    name: row.name,
    contactEmail: row.contactEmail,
    title: row.title,
    company: row.company,
    bio: row.bio,
    socialUrls: {
      website: typeof social.website === "string" ? social.website : null,
      linkedin: typeof social.linkedin === "string" ? social.linkedin : null,
      x: typeof social.x === "string" ? social.x : null,
    },
    travelPreferences: row.travelPreferences,
    workflowStatus: row.workflowStatus,
    profileStatus: row.profileStatus,
    agreementStatus: row.agreementStatus,
    publicVisibility: row.publicVisibility,
    headshot: headshotComplete ? {
      originalFilename: row.headshotOriginalFilename!,
      contentType: row.headshotContentType!,
      byteSize: row.headshotByteSize!,
      sha256: row.headshotSha256!,
      uploadedAt: row.headshotUploadedAt!,
      revision: row.revision,
      viewPath: lane === "speaker"
        ? `/api/events/${encodeURIComponent(eventSlug)}/speaker/headshot/file`
        : `/api/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(row.id)}/headshot/file`,
      publicUrl: row.publicVisibility === "published"
        ? `/api/public/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(row.slug)}/headshot?v=${row.headshotSha256!.slice(0, 12)}`
        : null,
    } : null,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

function sessionProjection(row: SessionRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    track: row.track,
    format: row.format,
    deliverablesStatus: row.deliverablesStatus,
    approvalStatus: row.approvalStatus,
    revision: row.revision,
    ...(row.room && row.startsAt && row.endsAt
      ? { schedule: { room: row.room, startsAt: row.startsAt, endsAt: row.endsAt } }
      : {}),
  };
}

function taskProjection(row: TaskRow): SpeakerTaskResponse {
  return {
    id: row.id, sessionId: row.sessionId, taskKey: row.taskKey, label: row.label,
    state: row.state, dueAt: row.dueAt, completedAt: row.completedAt,
    revision: row.revision, updatedAt: row.updatedAt,
  };
}

function requestProjection(row: RequestRow): DeliverableRequestResponse {
  return {
    id: row.id, sessionId: row.sessionId, requestKey: row.requestKey,
    requestType: row.requestType, label: row.label, instructions: row.instructions,
    dueAt: row.dueAt, allowedContentTypes: parseArray(row.allowedContentTypesJson) as DeliverableRequestResponse["allowedContentTypes"],
    maxBytes: row.maxBytes, required: row.required === 1, active: row.active === 1,
    revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function versionProjection(
  row: VersionRow,
  eventSlug: string,
  lane: ProjectionLane = "organizer",
): DeliverableVersionResponse {
  return {
    id: row.id, requestId: row.requestId, sessionId: row.sessionId,
    requestType: row.requestType, versionNumber: row.versionNumber,
    originalFilename: row.originalFilename, contentType: row.contentType,
    byteSize: row.byteSize, sha256: row.sha256, note: row.note,
    uploader: { speakerId: row.uploaderSpeakerId, name: row.uploaderName },
    uploadedAt: row.uploadedAt,
    downloadPath: lane === "speaker"
      ? `/api/events/${encodeURIComponent(eventSlug)}/speaker/deliverables/${encodeURIComponent(row.id)}/file`
      : `/api/events/${encodeURIComponent(eventSlug)}/content/deliverables/${encodeURIComponent(row.id)}/file`,
    publicUrl: null,
  };
}

function commentProjection(row: CommentRow): ContentCommentResponse {
  return {
    id: row.id, sessionId: row.sessionId, versionId: row.versionId,
    author: row.authorSpeakerId
      ? { kind: "speaker", name: row.speakerName!, speakerId: row.authorSpeakerId }
      : { kind: "organizer", name: row.organizerName!, speakerId: null },
    body: row.body, createdAt: row.createdAt,
  };
}

function reviewProjection(row: ReviewRow): ContentReviewResponse {
  return {
    id: row.id, sessionId: row.sessionId, versionId: row.versionId,
    outcome: row.outcome, comment: row.comment, reviewerName: row.reviewerName,
    reviewedAt: row.reviewedAt,
  };
}

function historyProjection(row: HistoryRow): SessionContentHistoryResponse {
  return {
    id: row.id, sessionId: row.sessionId, action: row.action, title: row.title,
    abstract: row.abstract, track: row.track, format: row.format,
    durationMinutes: row.durationMinutes, changeNote: row.changeNote,
    actorName: row.actorName, createdAt: row.createdAt,
  };
}

function speakerHistorySnapshot(row: SpeakerRow, eventSlug: string): SpeakerProfileHistorySnapshot {
  const { contactEmail: _privateContactEmail, ...snapshot } = profileProjection(row, eventSlug);
  return snapshot;
}

function decodeSpeakerHistorySnapshot(value: string): SpeakerProfileHistorySnapshot | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { contactEmail: _privateContactEmail, ...snapshot } = parsed as Record<string, unknown>;
    const result = speakerProfileHistorySnapshotSchema.safeParse(snapshot);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

interface ReadState {
  event: EventRow;
  speakers: SpeakerRow[];
  sessions: SessionRow[];
  presenters: PresenterRow[];
  tasks: TaskRow[];
  requests: RequestRow[];
  versions: VersionRow[];
  comments: CommentRow[];
  reviews: ReviewRow[];
  history: HistoryRow[];
  speakerHistory: SpeakerHistoryRow[];
}

async function readState(database: Database, eventId: string): Promise<ReadState> {
  const [eventResult, speakers, sessions, presenters, tasks, requests, versions, comments, reviews, history, speakerHistory] = await database.batch([
    database.prepare("SELECT id, slug, name FROM events WHERE id = ? LIMIT 1").bind(eventId),
    database.prepare(`SELECT id, user_id AS userId, slug, name,
      COALESCE(NULLIF(contact_email, ''), (SELECT email FROM users WHERE id = speakers.user_id)) AS contactEmail,
      title, company, bio, social_urls_json AS socialUrlsJson, travel_preferences AS travelPreferences,
      workflow_status AS workflowStatus, profile_status AS profileStatus,
      agreement_status AS agreementStatus, public_visibility AS publicVisibility,
      headshot_object_key AS headshotObjectKey, headshot_original_filename AS headshotOriginalFilename,
      headshot_content_type AS headshotContentType, headshot_byte_size AS headshotByteSize,
      headshot_sha256 AS headshotSha256, headshot_uploaded_at AS headshotUploadedAt,
      revision, updated_at AS updatedAt
      FROM speakers WHERE event_id = ? ORDER BY name COLLATE NOCASE, id`).bind(eventId),
    database.prepare(`SELECT session.id, session.slug, session.title, session.abstract, session.track,
      session.format, session.duration_minutes AS durationMinutes,
      session.deliverables_status AS deliverablesStatus, session.approval_status AS approvalStatus,
      session.revision, room.name AS room, placement.starts_at AS startsAt, placement.ends_at AS endsAt
      FROM program_sessions session
      INNER JOIN acceptances acceptance ON acceptance.event_id = session.event_id
        AND acceptance.program_session_id = session.id
      LEFT JOIN schedule_placements placement ON placement.event_id = session.event_id
        AND placement.program_session_id = session.id
      LEFT JOIN rooms room ON room.event_id = placement.event_id AND room.id = placement.room_id
      WHERE session.event_id = ? ORDER BY COALESCE(placement.starts_at, '9999'), session.title COLLATE NOCASE, session.id`).bind(eventId),
    database.prepare(`SELECT program_session_id AS sessionId, speaker_id AS speakerId, role
      FROM session_presenters WHERE event_id = ? ORDER BY program_session_id, role DESC, speaker_id`).bind(eventId),
    database.prepare(`SELECT id, program_session_id AS sessionId, speaker_id AS speakerId,
      task_key AS taskKey, label, state, due_at AS dueAt, completed_at AS completedAt,
      revision, updated_at AS updatedAt FROM speaker_tasks WHERE event_id = ?
      ORDER BY created_at, id`).bind(eventId),
    database.prepare(`SELECT id, program_session_id AS sessionId, request_key AS requestKey,
      request_type AS requestType, label, instructions, due_at AS dueAt,
      allowed_content_types_json AS allowedContentTypesJson, max_bytes AS maxBytes,
      required, active, revision, created_at AS createdAt, updated_at AS updatedAt
      FROM deliverable_requests WHERE event_id = ? ORDER BY due_at, id`).bind(eventId),
    database.prepare(`SELECT version.id, version.request_id AS requestId,
      version.program_session_id AS sessionId, request.request_type AS requestType,
      version.version_number AS versionNumber, version.original_filename AS originalFilename,
      version.object_key AS objectKey, version.content_type AS contentType,
      version.byte_size AS byteSize, version.sha256, version.note,
      version.uploaded_by_speaker_id AS uploaderSpeakerId, speaker.name AS uploaderName,
      version.uploaded_at AS uploadedAt
      FROM deliverable_versions version
      INNER JOIN deliverable_requests request ON request.event_id = version.event_id AND request.id = version.request_id
      INNER JOIN speakers speaker ON speaker.event_id = version.event_id AND speaker.id = version.uploaded_by_speaker_id
      WHERE version.event_id = ? ORDER BY version.request_id, version.version_number`).bind(eventId),
    database.prepare(`SELECT comment.id, comment.program_session_id AS sessionId,
      comment.version_id AS versionId, comment.author_speaker_id AS authorSpeakerId,
      speaker.name AS speakerName, user.display_name AS organizerName, comment.body,
      comment.created_at AS createdAt FROM content_comments comment
      LEFT JOIN speakers speaker ON speaker.event_id = comment.event_id AND speaker.id = comment.author_speaker_id
      LEFT JOIN users user ON user.id = comment.author_user_id
      WHERE comment.event_id = ? ORDER BY comment.created_at, comment.id`).bind(eventId),
    database.prepare(`SELECT review.id, review.program_session_id AS sessionId,
      review.version_id AS versionId, review.outcome, review.comment,
      user.display_name AS reviewerName, review.reviewed_at AS reviewedAt
      FROM content_reviews review INNER JOIN users user ON user.id = review.reviewed_by_user_id
      WHERE review.event_id = ? ORDER BY review.reviewed_at, review.id`).bind(eventId),
    database.prepare(`SELECT history.id, history.program_session_id AS sessionId,
      history.action, history.title, history.abstract, history.track, history.format,
      history.duration_minutes AS durationMinutes, history.change_note AS changeNote,
      user.display_name AS actorName, history.created_at AS createdAt
      FROM session_content_history history INNER JOIN users user ON user.id = history.actor_user_id
      WHERE history.event_id = ? ORDER BY history.created_at, history.id`).bind(eventId),
    database.prepare(`SELECT history.id, history.speaker_id AS speakerId, history.action,
      history.profile_json AS profileJson, history.change_note AS changeNote,
      user.display_name AS actorName, history.created_at AS createdAt
      FROM speaker_content_history history INNER JOIN users user ON user.id = history.actor_user_id
      WHERE history.event_id = ? ORDER BY history.created_at, history.id`).bind(eventId),
  ]);
  const event = eventResult.results[0] as EventRow | undefined;
  if (!event) throw new SpeakerContentNotFoundError();
  return {
    event,
    speakers: speakers.results as unknown as SpeakerRow[],
    sessions: sessions.results as unknown as SessionRow[],
    presenters: presenters.results as unknown as PresenterRow[],
    tasks: tasks.results as unknown as TaskRow[],
    requests: requests.results as unknown as RequestRow[],
    versions: versions.results as unknown as VersionRow[],
    comments: comments.results as unknown as CommentRow[],
    reviews: reviews.results as unknown as ReviewRow[],
    history: history.results as unknown as HistoryRow[],
    speakerHistory: speakerHistory.results as unknown as SpeakerHistoryRow[],
  };
}

async function readSpeakerState(
  database: Database,
  eventId: string,
  authUserId: string,
): Promise<ReadState> {
  const [event, speaker] = await Promise.all([
    database.prepare("SELECT id, slug, name FROM events WHERE id = ? LIMIT 1")
      .bind(eventId).first<EventRow>(),
    ownedSpeaker(database, eventId, authUserId),
  ]);
  if (!event || !speaker) throw new SpeakerContentNotFoundError();

  const [sessions, presenters, tasks, requests, versions, comments, reviews] = await database.batch([
    database.prepare(`SELECT session.id, session.slug, session.title, session.abstract, session.track,
      session.format, session.duration_minutes AS durationMinutes,
      session.deliverables_status AS deliverablesStatus, session.approval_status AS approvalStatus,
      session.revision, room.name AS room, placement.starts_at AS startsAt, placement.ends_at AS endsAt
      FROM program_sessions session
      INNER JOIN acceptances acceptance ON acceptance.event_id = session.event_id
        AND acceptance.program_session_id = session.id
      LEFT JOIN schedule_placements placement ON placement.event_id = session.event_id
        AND placement.program_session_id = session.id
      LEFT JOIN rooms room ON room.event_id = placement.event_id AND room.id = placement.room_id
      WHERE session.event_id = ? AND EXISTS (
        SELECT 1 FROM session_presenters owned_presenter
        INNER JOIN speakers owner ON owner.event_id = owned_presenter.event_id
          AND owner.id = owned_presenter.speaker_id
        WHERE owned_presenter.event_id = session.event_id
          AND owned_presenter.program_session_id = session.id AND owner.user_id = ?
      ) ORDER BY COALESCE(placement.starts_at, '9999'), session.title COLLATE NOCASE, session.id`)
      .bind(eventId, authUserId),
    database.prepare(`SELECT presenter.program_session_id AS sessionId,
      presenter.speaker_id AS speakerId, presenter.role
      FROM session_presenters presenter
      INNER JOIN speakers owner ON owner.event_id = presenter.event_id
        AND owner.id = presenter.speaker_id
      WHERE presenter.event_id = ? AND owner.user_id = ?
      ORDER BY presenter.program_session_id, presenter.role DESC, presenter.speaker_id`)
      .bind(eventId, authUserId),
    database.prepare(`SELECT task.id, task.program_session_id AS sessionId,
      task.speaker_id AS speakerId, task.task_key AS taskKey, task.label, task.state,
      task.due_at AS dueAt, task.completed_at AS completedAt, task.revision,
      task.updated_at AS updatedAt
      FROM speaker_tasks task
      INNER JOIN speakers owner ON owner.event_id = task.event_id AND owner.id = task.speaker_id
      WHERE task.event_id = ? AND owner.user_id = ? ORDER BY task.created_at, task.id`)
      .bind(eventId, authUserId),
    database.prepare(`SELECT request.id, request.program_session_id AS sessionId,
      request.request_key AS requestKey, request.request_type AS requestType,
      request.label, request.instructions, request.due_at AS dueAt,
      request.allowed_content_types_json AS allowedContentTypesJson,
      request.max_bytes AS maxBytes, request.required, request.active, request.revision,
      request.created_at AS createdAt, request.updated_at AS updatedAt
      FROM deliverable_requests request WHERE request.event_id = ? AND EXISTS (
        SELECT 1 FROM session_presenters owned_presenter
        INNER JOIN speakers owner ON owner.event_id = owned_presenter.event_id
          AND owner.id = owned_presenter.speaker_id
        WHERE owned_presenter.event_id = request.event_id
          AND owned_presenter.program_session_id = request.program_session_id AND owner.user_id = ?
      ) ORDER BY request.due_at, request.id`).bind(eventId, authUserId),
    database.prepare(`SELECT version.id, version.request_id AS requestId,
      version.program_session_id AS sessionId, request.request_type AS requestType,
      version.version_number AS versionNumber, version.original_filename AS originalFilename,
      version.object_key AS objectKey, version.content_type AS contentType,
      version.byte_size AS byteSize, version.sha256, version.note,
      version.uploaded_by_speaker_id AS uploaderSpeakerId, uploader.name AS uploaderName,
      version.uploaded_at AS uploadedAt
      FROM deliverable_versions version
      INNER JOIN deliverable_requests request ON request.event_id = version.event_id
        AND request.id = version.request_id
      INNER JOIN speakers uploader ON uploader.event_id = version.event_id
        AND uploader.id = version.uploaded_by_speaker_id
      WHERE version.event_id = ? AND EXISTS (
        SELECT 1 FROM session_presenters owned_presenter
        INNER JOIN speakers owner ON owner.event_id = owned_presenter.event_id
          AND owner.id = owned_presenter.speaker_id
        WHERE owned_presenter.event_id = version.event_id
          AND owned_presenter.program_session_id = version.program_session_id AND owner.user_id = ?
      ) ORDER BY version.request_id, version.version_number`).bind(eventId, authUserId),
    database.prepare(`SELECT comment.id, comment.program_session_id AS sessionId,
      comment.version_id AS versionId, comment.author_speaker_id AS authorSpeakerId,
      speaker.name AS speakerName, user.display_name AS organizerName, comment.body,
      comment.created_at AS createdAt FROM content_comments comment
      LEFT JOIN speakers speaker ON speaker.event_id = comment.event_id
        AND speaker.id = comment.author_speaker_id
      LEFT JOIN users user ON user.id = comment.author_user_id
      WHERE comment.event_id = ? AND EXISTS (
        SELECT 1 FROM session_presenters owned_presenter
        INNER JOIN speakers owner ON owner.event_id = owned_presenter.event_id
          AND owner.id = owned_presenter.speaker_id
        WHERE owned_presenter.event_id = comment.event_id
          AND owned_presenter.program_session_id = comment.program_session_id AND owner.user_id = ?
      ) ORDER BY comment.created_at, comment.id`).bind(eventId, authUserId),
    database.prepare(`SELECT review.id, review.program_session_id AS sessionId,
      review.version_id AS versionId, review.outcome, review.comment,
      user.display_name AS reviewerName, review.reviewed_at AS reviewedAt
      FROM content_reviews review INNER JOIN users user ON user.id = review.reviewed_by_user_id
      WHERE review.event_id = ? AND EXISTS (
        SELECT 1 FROM session_presenters owned_presenter
        INNER JOIN speakers owner ON owner.event_id = owned_presenter.event_id
          AND owner.id = owned_presenter.speaker_id
        WHERE owned_presenter.event_id = review.event_id
          AND owned_presenter.program_session_id = review.program_session_id AND owner.user_id = ?
      ) ORDER BY review.reviewed_at, review.id`).bind(eventId, authUserId),
  ]);

  return {
    event,
    speakers: [speaker],
    sessions: sessions.results as unknown as SessionRow[],
    presenters: presenters.results as unknown as PresenterRow[],
    tasks: tasks.results as unknown as TaskRow[],
    requests: requests.results as unknown as RequestRow[],
    versions: versions.results as unknown as VersionRow[],
    comments: comments.results as unknown as CommentRow[],
    reviews: reviews.results as unknown as ReviewRow[],
    history: [],
    speakerHistory: [],
  };
}

export async function getSpeakerContentWorkspace(
  database: Database,
  eventId: string,
  authUserId: string,
): Promise<SpeakerContentWorkspaceResponse> {
  const state = await readSpeakerState(database, eventId, authUserId);
  const speaker = state.speakers.find((value) => value.userId === authUserId);
  if (!speaker) throw new SpeakerContentNotFoundError();
  const sessionIds = new Set(state.presenters
    .filter((presenter) => presenter.speakerId === speaker.id)
    .map((presenter) => presenter.sessionId));
  const versionsByRequest = groupBy(state.versions, (version) => version.requestId);
  const data = {
    event: { slug: state.event.slug, name: state.event.name },
    speaker: profileProjection(speaker, state.event.slug, "speaker"),
    sessions: state.sessions.filter((session) => sessionIds.has(session.id)).map((session) => ({
      ...sessionProjection(session),
      tasks: state.tasks.filter((task) => task.sessionId === session.id && task.speakerId === speaker.id).map(taskProjection),
      requests: state.requests.filter((request) => request.sessionId === session.id && request.active === 1).map((request) => ({
        ...requestProjection(request),
        versions: (versionsByRequest.get(request.id) ?? []).map((version) =>
          versionProjection(version, state.event.slug, "speaker")),
      })),
      comments: state.comments.filter((comment) => comment.sessionId === session.id).map(commentProjection),
      reviews: state.reviews.filter((review) => review.sessionId === session.id).map(reviewProjection),
    })),
  };
  return speakerContentWorkspaceResponseSchema.parse(data);
}

function latestVersionFor(requestId: string, versions: readonly VersionRow[]) {
  return versions.filter((version) => version.requestId === requestId)
    .sort((left, right) => right.versionNumber - left.versionNumber)[0];
}

function latestReviewFor(versionId: string, reviews: readonly ReviewRow[]) {
  return reviews.filter((review) => review.versionId === versionId)
    .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt) || right.id.localeCompare(left.id))[0];
}

function unmetGates(sessionId: string, state: ReadState) {
  const gates: string[] = [];
  const presenters = state.presenters.filter((presenter) => presenter.sessionId === sessionId);
  const requests = state.requests.filter((request) => request.sessionId === sessionId && request.active === 1 && request.required === 1);
  if (requests.some((request) => {
    const version = latestVersionFor(request.id, state.versions);
    return !version || latestReviewFor(version.id, state.reviews)?.outcome !== "approved";
  })) gates.push("Approve the latest version of every required deliverable.");
  if (state.tasks.some((task) => task.sessionId === sessionId && task.state === "open")) {
    gates.push("Complete or waive every presenter task.");
  }
  if (presenters.some((presenter) => {
    const speaker = state.speakers.find((value) => value.id === presenter.speakerId);
    return !speaker || speaker.workflowStatus !== "confirmed"
      || speaker.profileStatus !== "ready" || speaker.agreementStatus !== "signed";
  })) gates.push("Confirm participation, complete the profile, and sign for every presenter.");
  if (!presenters.some((presenter) => presenter.role === "primary"
    && state.speakers.find((speaker) => speaker.id === presenter.speakerId)?.publicVisibility === "published")) {
    gates.push("Publish the primary speaker profile.");
  }
  return gates;
}

export async function getOrganizerSpeakerRoster(
  database: Database,
  eventId: string,
): Promise<OrganizerSpeakerRosterResponse> {
  const state = await readState(database, eventId);
  const data = {
    event: { slug: state.event.slug, name: state.event.name },
    speakers: state.speakers.map((speaker) => {
      const sessionIds = new Set(state.presenters.filter((presenter) => presenter.speakerId === speaker.id).map((presenter) => presenter.sessionId));
      const sessions = state.sessions.filter((session) => sessionIds.has(session.id));
      const tasks = state.tasks.filter((task) => task.speakerId === speaker.id && sessionIds.has(task.sessionId));
      const due = [
        ...tasks.filter((task) => task.state === "open" && task.dueAt).map((task) => task.dueAt!),
        ...state.requests.filter((request) => sessionIds.has(request.sessionId) && request.active === 1).map((request) => request.dueAt),
      ].sort()[0] ?? null;
      const history: SpeakerContentHistoryResponse[] = state.speakerHistory
        .filter((item) => item.speakerId === speaker.id)
        .flatMap((item) => {
          const profile = decodeSpeakerHistorySnapshot(item.profileJson);
          return profile ? [{
            id: item.id, speakerId: item.speakerId, action: item.action,
            profile,
            changeNote: item.changeNote, actorName: item.actorName, createdAt: item.createdAt,
          }] : [];
        });
      return {
        accountLinked: speaker.userId !== null,
        profile: profileProjection(speaker, state.event.slug),
        history,
        sessions: sessions.map(sessionProjection),
        tasks: tasks.map(taskProjection),
        readiness: {
          profileReady: speaker.profileStatus === "ready",
          agreementReady: speaker.agreementStatus === "signed",
          headshotReady: speaker.headshotObjectKey !== null,
          requiredTasksReady: tasks.every((task) => task.state !== "open"),
          deliverablesReady: sessions.every((session) => session.deliverablesStatus === "ready"),
          nextDueAt: due,
        },
      };
    }),
  };
  return organizerSpeakerRosterResponseSchema.parse(data);
}

export async function getOrganizerContent(
  database: Database,
  eventId: string,
): Promise<OrganizerContentListResponse> {
  const state = await readState(database, eventId);
  const data = {
    event: { slug: state.event.slug, name: state.event.name },
    approvedDeliverablesArchivePath: `/api/events/${encodeURIComponent(state.event.slug)}/content/deliverables.zip`,
    sessions: state.sessions.map((session) => {
      const speakerIds = new Set(state.presenters.filter((presenter) => presenter.sessionId === session.id).map((presenter) => presenter.speakerId));
      return {
        ...sessionProjection(session),
        abstract: session.abstract,
        durationMinutes: session.durationMinutes,
        presenters: state.speakers.filter((speaker) => speakerIds.has(speaker.id)).map((speaker) => profileProjection(speaker, state.event.slug)),
        tasks: state.tasks.filter((task) => task.sessionId === session.id).map(taskProjection),
        requests: state.requests.filter((request) => request.sessionId === session.id).map(requestProjection),
        versions: state.versions.filter((version) => version.sessionId === session.id).map((version) => versionProjection(version, state.event.slug)),
        comments: state.comments.filter((comment) => comment.sessionId === session.id).map(commentProjection),
        reviews: state.reviews.filter((review) => review.sessionId === session.id).map(reviewProjection),
        history: state.history.filter((history) => history.sessionId === session.id).map(historyProjection),
        unmetApprovalGates: unmetGates(session.id, state),
      };
    }),
  };
  return organizerContentListResponseSchema.parse(data);
}

export async function updateSessionApproval(
  database: Database,
  input: { eventId: string; sessionId: string; value: SessionApprovalUpdate; now: string },
) {
  const current = await readSession(database, input.eventId, input.sessionId);
  if (!current) throw new SpeakerContentNotFoundError();
  if (current.revision === input.value.expectedRevision + 1
    && current.approvalStatus === input.value.approvalStatus) {
    return getOrganizerContent(database, input.eventId);
  }
  if (current.revision !== input.value.expectedRevision) throw new SpeakerContentConflictError();
  if (current.approvalStatus === input.value.approvalStatus) {
    return getOrganizerContent(database, input.eventId);
  }
  try {
    const result = await database.prepare(`UPDATE program_sessions
      SET approval_status = ?, revision = revision + 1,
        updated_at = ${MONOTONIC_UPDATED_AT_SQL}
      WHERE event_id = ? AND id = ? AND revision = ?`)
      .bind(
        input.value.approvalStatus, input.now, input.now,
        input.eventId, input.sessionId, input.value.expectedRevision,
      ).run();
    if (result.meta.changes !== 1) throw new SpeakerContentConflictError();
  } catch (error) {
    if (error instanceof SpeakerContentConflictError) throw error;
    const message = constraintMessage(error);
    if (/approval|deliverable|presenter|task|agreement|profile|primary/i.test(message)) {
      throw new SpeakerContentApprovalBlockedError(message);
    }
    throw error;
  }
  return getOrganizerContent(database, input.eventId);
}

export const speakerContentProjection = {
  profileProjection,
  taskProjection,
  requestProjection,
  versionProjection,
  commentProjection,
  reviewProjection,
  historyProjection,
};

function sameSocial(row: SpeakerRow, input: SpeakerProfileUpdate) {
  const social = parseObject(row.socialUrlsJson);
  return (typeof social.website === "string" ? social.website : null) === input.socialUrls.website
    && (typeof social.linkedin === "string" ? social.linkedin : null) === input.socialUrls.linkedin
    && (typeof social.x === "string" ? social.x : null) === input.socialUrls.x;
}

function sameProfile(row: SpeakerRow, input: SpeakerProfileUpdate) {
  return row.name === input.name
    && row.contactEmail === input.contactEmail
    && row.title === input.title
    && row.company === input.company
    && row.bio === input.bio
    && sameSocial(row, input)
    && row.travelPreferences === input.travelPreferences
    && row.publicVisibility === input.publicVisibility;
}

function profileReady(input: Pick<SpeakerProfileUpdate, "name" | "contactEmail" | "title" | "company" | "bio">) {
  return [input.name, input.contactEmail, input.title, input.company, input.bio]
    .every((value) => value.trim().length > 0);
}

async function eventSlug(database: Database, eventId: string) {
  const event = await database.prepare("SELECT slug FROM events WHERE id = ? LIMIT 1")
    .bind(eventId).first<{ slug: string }>();
  if (!event) throw new SpeakerContentNotFoundError();
  return event.slug;
}

async function ownedSpeaker(database: Database, eventId: string, userId: string) {
  const { results } = await database.prepare(`SELECT id, user_id AS userId, slug, name,
    COALESCE(NULLIF(contact_email, ''), (SELECT email FROM users WHERE id = speakers.user_id)) AS contactEmail,
    title, company, bio, social_urls_json AS socialUrlsJson,
    travel_preferences AS travelPreferences, workflow_status AS workflowStatus,
    profile_status AS profileStatus, agreement_status AS agreementStatus,
    public_visibility AS publicVisibility, headshot_object_key AS headshotObjectKey,
    headshot_original_filename AS headshotOriginalFilename,
    headshot_content_type AS headshotContentType, headshot_byte_size AS headshotByteSize,
    headshot_sha256 AS headshotSha256, headshot_uploaded_at AS headshotUploadedAt,
    revision, updated_at AS updatedAt FROM speakers WHERE event_id = ? AND user_id = ? LIMIT 1`)
    .bind(eventId, userId).all<SpeakerRow>();
  return results[0] ?? null;
}

async function speakerById(database: Database, eventId: string, speakerId: string) {
  const { results } = await database.prepare(`SELECT id, user_id AS userId, slug, name,
    COALESCE(NULLIF(contact_email, ''), (SELECT email FROM users WHERE id = speakers.user_id)) AS contactEmail,
    title, company, bio, social_urls_json AS socialUrlsJson,
    travel_preferences AS travelPreferences, workflow_status AS workflowStatus,
    profile_status AS profileStatus, agreement_status AS agreementStatus,
    public_visibility AS publicVisibility, headshot_object_key AS headshotObjectKey,
    headshot_original_filename AS headshotOriginalFilename,
    headshot_content_type AS headshotContentType, headshot_byte_size AS headshotByteSize,
    headshot_sha256 AS headshotSha256, headshot_uploaded_at AS headshotUploadedAt,
    revision, updated_at AS updatedAt FROM speakers WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, speakerId).all<SpeakerRow>();
  return results[0] ?? null;
}

export async function updateOwnedSpeakerProfile(
  database: Database,
  input: { eventId: string; userId: string; value: SpeakerOwnedProfileUpdate; now: string },
) {
  const current = await ownedSpeaker(database, input.eventId, input.userId);
  if (!current) throw new SpeakerContentNotFoundError();
  const intended = { ...input.value, publicVisibility: current.publicVisibility };
  const ready = profileReady(input.value);
  const intendedProfileStatus = ready ? "ready" : "incomplete";
  if (current.revision === input.value.revision + 1 && sameProfile(current, intended)
    && current.profileStatus === intendedProfileStatus) {
    return profileProjection(current, await eventSlug(database, input.eventId), "speaker");
  }
  if (current.revision !== input.value.revision) throw new SpeakerContentConflictError();
  if (sameProfile(current, intended) && current.profileStatus === intendedProfileStatus) {
    return profileProjection(current, await eventSlug(database, input.eventId), "speaker");
  }
  const snapshot = speakerHistorySnapshot(current, await eventSlug(database, input.eventId));
  await database.batch([
    database.prepare(`INSERT INTO speaker_content_history (
      id, event_id, speaker_id, action, profile_json, change_note, actor_user_id, created_at
    ) SELECT ?, event_id, id, 'updated', ?, 'Speaker updated profile', ?, ?
      FROM speakers WHERE event_id = ? AND user_id = ? AND revision = ?`).bind(
      crypto.randomUUID(), JSON.stringify(snapshot), input.userId, input.now,
      input.eventId, input.userId, input.value.revision,
    ),
    database.prepare(`UPDATE speakers SET
      name = ?, contact_email = ?, title = ?, company = ?, bio = ?, social_urls_json = ?,
      travel_preferences = ?, profile_status = ?, revision = revision + 1,
      updated_at = ${MONOTONIC_UPDATED_AT_SQL}
      WHERE event_id = ? AND user_id = ? AND revision = ?`).bind(
      input.value.name, input.value.contactEmail, input.value.title, input.value.company,
      input.value.bio, JSON.stringify(input.value.socialUrls), input.value.travelPreferences,
      ready ? "ready" : "incomplete", input.now, input.now,
      input.eventId, input.userId, input.value.revision,
    ),
  ]);
  const updated = await ownedSpeaker(database, input.eventId, input.userId);
  if (!updated) throw new SpeakerContentNotFoundError();
  if (updated.revision !== input.value.revision + 1 || !sameProfile(updated, intended)) {
    throw new SpeakerContentConflictError();
  }
  return profileProjection(updated, await eventSlug(database, input.eventId), "speaker");
}

export async function updateOrganizerSpeakerProfile(
  database: Database,
  input: { eventId: string; speakerId: string; actorUserId: string; value: SpeakerProfileUpdate; now: string },
) {
  const current = await speakerById(database, input.eventId, input.speakerId);
  if (!current) throw new SpeakerContentNotFoundError();
  const ready = profileReady(input.value);
  const intendedProfileStatus = ready ? "ready" : "incomplete";
  if (current.revision === input.value.revision + 1 && sameProfile(current, input.value)
    && current.profileStatus === intendedProfileStatus) {
    return profileProjection(current, await eventSlug(database, input.eventId));
  }
  if (current.revision !== input.value.revision) throw new SpeakerContentConflictError();
  if (sameProfile(current, input.value) && current.profileStatus === intendedProfileStatus) {
    return profileProjection(current, await eventSlug(database, input.eventId));
  }
  if (input.value.publicVisibility === "published" && !ready) {
    throw new SpeakerContentNotAllowedError("PROFILE_NOT_READY");
  }
  const snapshot = speakerHistorySnapshot(current, await eventSlug(database, input.eventId));
  await database.batch([
    database.prepare(`INSERT INTO speaker_content_history (
      id, event_id, speaker_id, action, profile_json, change_note, actor_user_id, created_at
    ) SELECT ?, event_id, id, 'updated', ?, 'Updated speaker profile', ?, ?
      FROM speakers WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      crypto.randomUUID(), JSON.stringify(snapshot), input.actorUserId, input.now,
      input.eventId, input.speakerId, input.value.revision,
    ),
    database.prepare(`UPDATE speakers SET
      name = ?, contact_email = ?, title = ?, company = ?, bio = ?, social_urls_json = ?,
      travel_preferences = ?, public_visibility = ?, profile_status = ?, revision = revision + 1,
      updated_at = ${MONOTONIC_UPDATED_AT_SQL}
      WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      input.value.name, input.value.contactEmail, input.value.title, input.value.company,
      input.value.bio, JSON.stringify(input.value.socialUrls), input.value.travelPreferences,
      input.value.publicVisibility, ready ? "ready" : "incomplete", input.now, input.now,
      input.eventId, input.speakerId, input.value.revision,
    ),
  ]);
  const updated = await speakerById(database, input.eventId, input.speakerId);
  if (!updated || updated.revision !== input.value.revision + 1 || !sameProfile(updated, input.value)) {
    throw new SpeakerContentConflictError();
  }
  return profileProjection(updated, await eventSlug(database, input.eventId));
}

async function readTask(database: Database, eventId: string, taskId: string) {
  return database.prepare(`SELECT id, program_session_id AS sessionId, speaker_id AS speakerId,
    task_key AS taskKey, label, state, due_at AS dueAt, completed_at AS completedAt,
    revision, updated_at AS updatedAt FROM speaker_tasks WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, taskId).first<TaskRow>();
}

async function mutateTask(
  database: Database,
  current: TaskRow & { eventId: string },
  value: SpeakerTaskUpdate | OrganizerSpeakerTaskUpdate,
  now: string,
) {
  const nextDueAt = "dueAt" in value && value.dueAt !== undefined ? value.dueAt : current.dueAt;
  if (current.revision === value.revision + 1 && current.state === value.state && current.dueAt === nextDueAt) {
    return taskProjection(current);
  }
  if (current.revision !== value.revision) throw new SpeakerContentConflictError();
  if (current.state === value.state && current.dueAt === nextDueAt) return taskProjection(current);
  const completedAt = value.state === "complete"
    ? current.state === "complete" ? current.completedAt : now
    : null;
  const updateTask = database.prepare(`UPDATE speaker_tasks SET state = ?, completed_at = ?, due_at = ?,
    revision = revision + 1, updated_at = ${MONOTONIC_UPDATED_AT_SQL}
    WHERE event_id = ? AND id = ? AND revision = ?`)
    .bind(value.state, completedAt, nextDueAt, now, now, current.eventId, current.id, value.revision);
  if (current.taskKey === "release") {
    await database.batch([
      updateTask,
      database.prepare(`UPDATE speakers SET
        agreement_status = CASE WHEN EXISTS (
          SELECT 1 FROM speaker_tasks release_task
          WHERE release_task.event_id = speakers.event_id
            AND release_task.speaker_id = speakers.id
            AND release_task.task_key = 'release'
            AND release_task.state IN ('complete', 'waived')
        ) THEN 'signed' ELSE 'missing' END,
        revision = revision + 1, updated_at = ${MONOTONIC_UPDATED_AT_SQL}
        WHERE event_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM speaker_tasks changed_task
            WHERE changed_task.event_id = speakers.event_id
              AND changed_task.id = ? AND changed_task.revision = ? AND changed_task.state = ?
          )
          AND agreement_status != CASE WHEN EXISTS (
            SELECT 1 FROM speaker_tasks release_task
            WHERE release_task.event_id = speakers.event_id
              AND release_task.speaker_id = speakers.id
              AND release_task.task_key = 'release'
              AND release_task.state IN ('complete', 'waived')
          ) THEN 'signed' ELSE 'missing' END`).bind(
        now, now, current.eventId, current.speakerId,
        current.id, value.revision + 1, value.state,
      ),
    ]);
  } else {
    const result = await updateTask.run();
    if (result.meta.changes < 1) throw new SpeakerContentConflictError();
  }
  const updated = await readTask(database, current.eventId, current.id);
  if (!updated) throw new SpeakerContentNotFoundError();
  if (updated.revision !== value.revision + 1 || updated.state !== value.state || updated.dueAt !== nextDueAt) {
    throw new SpeakerContentConflictError();
  }
  return taskProjection(updated);
}

export async function updateOwnedSpeakerTask(
  database: Database,
  input: { eventId: string; userId: string; taskId: string; value: SpeakerTaskUpdate; now: string },
) {
  const current = await database.prepare(`SELECT task.id, task.event_id AS eventId,
    task.program_session_id AS sessionId, task.speaker_id AS speakerId, task.task_key AS taskKey,
    task.label, task.state, task.due_at AS dueAt, task.completed_at AS completedAt,
    task.revision, task.updated_at AS updatedAt FROM speaker_tasks task
    INNER JOIN speakers speaker ON speaker.event_id = task.event_id AND speaker.id = task.speaker_id
    WHERE task.event_id = ? AND task.id = ? AND speaker.user_id = ? LIMIT 1`)
    .bind(input.eventId, input.taskId, input.userId).first<TaskRow & { eventId: string }>();
  if (!current) throw new SpeakerContentNotFoundError();
  if (current.state === "waived") throw new SpeakerContentNotAllowedError("TASK_WAIVED");
  return mutateTask(database, current, input.value, input.now);
}

export async function updateOrganizerSpeakerTask(
  database: Database,
  input: { eventId: string; speakerId: string; taskId: string; value: OrganizerSpeakerTaskUpdate; now: string },
) {
  const current = await database.prepare(`SELECT id, event_id AS eventId,
    program_session_id AS sessionId, speaker_id AS speakerId, task_key AS taskKey,
    label, state, due_at AS dueAt, completed_at AS completedAt, revision, updated_at AS updatedAt
    FROM speaker_tasks WHERE event_id = ? AND speaker_id = ? AND id = ? LIMIT 1`)
    .bind(input.eventId, input.speakerId, input.taskId).first<TaskRow & { eventId: string }>();
  if (!current) throw new SpeakerContentNotFoundError();
  return mutateTask(database, current, input.value, input.now);
}

export async function createBulkSpeakerTasks(
  database: Database,
  input: { eventId: string; actorUserId: string; value: SpeakerTaskBulkCreate; now: string },
) {
  const checks = await database.batch(input.value.targets.map((target) => database.prepare(`SELECT
      acceptance.id AS acceptanceId, existing.id AS existingId, existing.label AS existingLabel,
      existing.due_at AS existingDueAt
    FROM acceptances acceptance
    INNER JOIN session_presenters presenter ON presenter.event_id = acceptance.event_id
      AND presenter.program_session_id = acceptance.program_session_id
      AND presenter.speaker_id = ?
    LEFT JOIN speaker_tasks existing ON existing.event_id = acceptance.event_id
      AND existing.program_session_id = acceptance.program_session_id
      AND existing.speaker_id = presenter.speaker_id AND existing.task_key = ?
    WHERE acceptance.event_id = ? AND acceptance.program_session_id = ? LIMIT 1`)
    .bind(target.speakerId, input.value.taskKey, input.eventId, target.sessionId)));
  const targets = checks.map((result, index) => ({
    target: input.value.targets[index]!,
    row: result.results[0] as { acceptanceId: string; existingId: string | null; existingLabel: string | null; existingDueAt: string | null } | undefined,
  }));
  if (targets.some(({ row }) => !row)) throw new SpeakerContentNotFoundError();
  if (targets.some(({ row }) => row!.existingId
    && (row!.existingLabel !== input.value.label || row!.existingDueAt !== input.value.dueAt))) {
    throw new SpeakerContentConflictError();
  }
  const pending = targets.filter(({ row }) => !row!.existingId);
  if (pending.length) {
    try {
      await database.batch(pending.map(({ target, row }) => database.prepare(`INSERT INTO speaker_tasks (
        id, event_id, acceptance_id, program_session_id, speaker_id, task_key, label,
        state, created_at, completed_at, due_at, revision, updated_at, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, ?, 1, ?, ?)`)
        .bind(
          crypto.randomUUID(), input.eventId, row!.acceptanceId, target.sessionId,
          target.speakerId, input.value.taskKey, input.value.label, input.now,
          input.value.dueAt, input.now, input.actorUserId,
        )));
    } catch (error) {
      const replay = await database.batch(input.value.targets.map((target) => database.prepare(`SELECT label, due_at AS dueAt
        FROM speaker_tasks WHERE event_id = ? AND program_session_id = ? AND speaker_id = ?
          AND task_key = ? LIMIT 1`).bind(
        input.eventId, target.sessionId, target.speakerId, input.value.taskKey,
      )));
      if (!replay.every((result) => {
        const row = result.results[0] as { label: string; dueAt: string } | undefined;
        return row?.label === input.value.label && row.dueAt === input.value.dueAt;
      })) throw error;
    }
  }
  return getOrganizerSpeakerRoster(database, input.eventId);
}

function sameRequest(row: RequestRow, input: DeliverableRequestCreate | DeliverableRequestUpdate) {
  return row.label === input.label && row.instructions === input.instructions
    && row.dueAt === input.dueAt
    && JSON.stringify(parseArray(row.allowedContentTypesJson)) === JSON.stringify(input.allowedContentTypes)
    && row.maxBytes === input.maxBytes && (row.required === 1) === input.required
    && (!("active" in input) || (row.active === 1) === input.active);
}

async function readRequest(database: Database, eventId: string, requestId: string) {
  return database.prepare(`SELECT id, program_session_id AS sessionId, request_key AS requestKey,
    request_type AS requestType, label, instructions, due_at AS dueAt,
    allowed_content_types_json AS allowedContentTypesJson, max_bytes AS maxBytes,
    required, active, revision, created_at AS createdAt, updated_at AS updatedAt
    FROM deliverable_requests WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, requestId).first<RequestRow>();
}

export async function createDeliverableRequest(
  database: Database,
  input: { eventId: string; sessionId: string; actorUserId: string; value: DeliverableRequestCreate; now: string },
) {
  const existing = await database.prepare(`SELECT id, program_session_id AS sessionId,
    request_key AS requestKey, request_type AS requestType, label, instructions, due_at AS dueAt,
    allowed_content_types_json AS allowedContentTypesJson, max_bytes AS maxBytes,
    required, active, revision, created_at AS createdAt, updated_at AS updatedAt
    FROM deliverable_requests WHERE event_id = ? AND program_session_id = ? AND request_key = ?
      AND active = 1 LIMIT 1`)
    .bind(input.eventId, input.sessionId, input.value.requestKey).first<RequestRow>();
  if (existing) {
    if (existing.requestType !== input.value.requestType || !sameRequest(existing, input.value)) {
      throw new SpeakerContentConflictError();
    }
    return requestProjection(existing);
  }
  const id = crypto.randomUUID();
  try {
    await database.prepare(`INSERT INTO deliverable_requests (
      id, event_id, program_session_id, request_key, request_type, label, instructions,
      due_at, allowed_content_types_json, max_bytes, required, active, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM program_sessions WHERE event_id = ? AND id = ?)`)
      .bind(
        id, input.eventId, input.sessionId, input.value.requestKey, input.value.requestType,
        input.value.label, input.value.instructions, input.value.dueAt,
        JSON.stringify(input.value.allowedContentTypes), input.value.maxBytes,
        input.value.required ? 1 : 0, input.actorUserId, input.actorUserId,
        input.now, input.now, input.eventId, input.sessionId,
      ).run();
  } catch (error) {
    const raced = await database.prepare(`SELECT id, program_session_id AS sessionId,
      request_key AS requestKey, request_type AS requestType, label, instructions, due_at AS dueAt,
      allowed_content_types_json AS allowedContentTypesJson, max_bytes AS maxBytes,
      required, active, revision, created_at AS createdAt, updated_at AS updatedAt
      FROM deliverable_requests WHERE event_id = ? AND program_session_id = ? AND request_key = ?
        AND active = 1 LIMIT 1`)
      .bind(input.eventId, input.sessionId, input.value.requestKey).first<RequestRow>();
    if (raced && raced.requestType === input.value.requestType && sameRequest(raced, input.value)) {
      return requestProjection(raced);
    }
    throw error;
  }
  const created = await readRequest(database, input.eventId, id);
  if (!created) throw new SpeakerContentNotFoundError();
  return requestProjection(created);
}

export async function updateDeliverableRequest(
  database: Database,
  input: { eventId: string; sessionId: string; requestId: string; actorUserId: string; value: DeliverableRequestUpdate; now: string },
) {
  const current = await readRequest(database, input.eventId, input.requestId);
  if (!current || current.sessionId !== input.sessionId) throw new SpeakerContentNotFoundError();
  if (current.revision === input.value.revision + 1 && sameRequest(current, input.value)) return requestProjection(current);
  if (current.revision !== input.value.revision) throw new SpeakerContentConflictError();
  if (sameRequest(current, input.value)) return requestProjection(current);
  const result = await database.prepare(`UPDATE deliverable_requests SET label = ?, instructions = ?,
    due_at = ?, allowed_content_types_json = ?, max_bytes = ?, required = ?, active = ?,
    updated_by_user_id = ?, revision = revision + 1,
    updated_at = ${MONOTONIC_UPDATED_AT_SQL}
    WHERE event_id = ? AND program_session_id = ? AND id = ? AND revision = ?`)
    .bind(
      input.value.label, input.value.instructions, input.value.dueAt,
      JSON.stringify(input.value.allowedContentTypes), input.value.maxBytes,
      input.value.required ? 1 : 0, input.value.active ? 1 : 0, input.actorUserId,
      input.now, input.now, input.eventId, input.sessionId, input.requestId, input.value.revision,
    ).run();
  if (result.meta.changes < 1) throw new SpeakerContentConflictError();
  const updated = await readRequest(database, input.eventId, input.requestId);
  if (!updated) throw new SpeakerContentNotFoundError();
  if (updated.revision !== input.value.revision + 1 || !sameRequest(updated, input.value)) {
    throw new SpeakerContentConflictError();
  }
  return requestProjection(updated);
}

export async function createContentComment(
  database: Database,
  input: {
    eventId: string; sessionId: string; value: ContentCommentCreate; now: string;
    authorUserId?: string; authorSpeakerId?: string;
  },
) {
  const id = crypto.randomUUID();
  const result = await database.prepare(`INSERT INTO content_comments (
    id, event_id, program_session_id, version_id, author_user_id, author_speaker_id, body, created_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
    SELECT 1 FROM deliverable_versions WHERE event_id = ? AND program_session_id = ? AND id = ?
  )`).bind(
    id, input.eventId, input.sessionId, input.value.versionId,
    input.authorUserId ?? null, input.authorSpeakerId ?? null, input.value.body, input.now,
    input.eventId, input.sessionId, input.value.versionId,
  ).run();
  if (result.meta.changes !== 1) throw new SpeakerContentNotFoundError();
  const row = await database.prepare(`SELECT comment.id,
    comment.program_session_id AS sessionId, comment.version_id AS versionId,
    comment.author_speaker_id AS authorSpeakerId, speaker.name AS speakerName,
    user.display_name AS organizerName, comment.body, comment.created_at AS createdAt
    FROM content_comments comment
    LEFT JOIN speakers speaker ON speaker.event_id = comment.event_id AND speaker.id = comment.author_speaker_id
    LEFT JOIN users user ON user.id = comment.author_user_id
    WHERE comment.event_id = ? AND comment.id = ? LIMIT 1`)
    .bind(input.eventId, id).first<CommentRow>();
  if (!row) throw new SpeakerContentNotFoundError();
  return commentProjection(row);
}

export async function speakerIdForUserSession(
  database: Database,
  eventId: string,
  userId: string,
  sessionId: string,
) {
  const row = await database.prepare(`SELECT speaker.id FROM speakers speaker
    INNER JOIN session_presenters presenter ON presenter.event_id = speaker.event_id
      AND presenter.speaker_id = speaker.id
    WHERE speaker.event_id = ? AND speaker.user_id = ? AND presenter.program_session_id = ? LIMIT 1`)
    .bind(eventId, userId, sessionId).first<{ id: string }>();
  return row?.id ?? null;
}

export async function createContentReview(
  database: Database,
  input: { eventId: string; sessionId: string; actorUserId: string; value: ContentReviewCreate; now: string },
) {
  const existing = await database.prepare(`SELECT review.id, review.program_session_id AS sessionId,
    review.version_id AS versionId, review.outcome, review.comment,
    user.display_name AS reviewerName, review.reviewed_at AS reviewedAt
    FROM content_reviews review INNER JOIN users user ON user.id = review.reviewed_by_user_id
    WHERE review.event_id = ? AND review.version_id = ? AND review.idempotency_key = ? LIMIT 1`)
    .bind(input.eventId, input.value.versionId, input.value.idempotencyKey).first<ReviewRow>();
  if (existing) {
    if (existing.sessionId !== input.sessionId
      || existing.outcome !== input.value.outcome || existing.comment !== input.value.comment) {
      throw new SpeakerContentConflictError();
    }
    return reviewProjection(existing);
  }
  const id = crypto.randomUUID();
  let result: DatabaseResult;
  try {
    result = await database.prepare(`INSERT INTO content_reviews (
    id, event_id, program_session_id, version_id, idempotency_key,
    outcome, comment, reviewed_by_user_id, reviewed_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, CASE
      WHEN COALESCE((SELECT MAX(reviewed_at) FROM content_reviews
        WHERE event_id = ? AND version_id = ?), '') >= ?
      THEN strftime('%Y-%m-%dT%H:%M:%SZ', (SELECT MAX(reviewed_at) FROM content_reviews
        WHERE event_id = ? AND version_id = ?), '+1 second')
      ELSE ? END
    WHERE EXISTS (
    SELECT 1 FROM program_sessions session
    INNER JOIN deliverable_versions version ON version.event_id = session.event_id
      AND version.program_session_id = session.id
    WHERE session.event_id = ? AND session.id = ? AND session.revision = ?
      AND version.id = ?
  )`).bind(
    id, input.eventId, input.sessionId, input.value.versionId, input.value.idempotencyKey,
    input.value.outcome, input.value.comment, input.actorUserId,
    input.eventId, input.value.versionId, input.now,
    input.eventId, input.value.versionId, input.now,
    input.eventId, input.sessionId, input.value.expectedSessionRevision, input.value.versionId,
    ).run();
  } catch (error) {
    const raced = await database.prepare(`SELECT review.id, review.program_session_id AS sessionId,
      review.version_id AS versionId, review.outcome, review.comment,
      user.display_name AS reviewerName, review.reviewed_at AS reviewedAt
      FROM content_reviews review INNER JOIN users user ON user.id = review.reviewed_by_user_id
      WHERE review.event_id = ? AND review.version_id = ? AND review.idempotency_key = ? LIMIT 1`)
      .bind(input.eventId, input.value.versionId, input.value.idempotencyKey).first<ReviewRow>();
    if (raced) {
      if (raced.sessionId === input.sessionId
        && raced.outcome === input.value.outcome && raced.comment === input.value.comment) {
        return reviewProjection(raced);
      }
      throw new SpeakerContentConflictError();
    }
    throw error;
  }
  // D1 includes the review's session-readiness trigger in meta.changes. A
  // positive count plus the canonical review lookup below proves the write.
  if (result.meta.changes < 1) throw new SpeakerContentConflictError();
  const row = await database.prepare(`SELECT review.id, review.program_session_id AS sessionId,
    review.version_id AS versionId, review.outcome, review.comment,
    user.display_name AS reviewerName, review.reviewed_at AS reviewedAt
    FROM content_reviews review INNER JOIN users user ON user.id = review.reviewed_by_user_id
    WHERE review.event_id = ? AND review.id = ? LIMIT 1`)
    .bind(input.eventId, id).first<ReviewRow>();
  if (!row) throw new SpeakerContentConflictError();
  return reviewProjection(row);
}

async function readSession(database: Database, eventId: string, sessionId: string) {
  return database.prepare(`SELECT id, slug, title, abstract, track, format,
    duration_minutes AS durationMinutes, deliverables_status AS deliverablesStatus,
    approval_status AS approvalStatus, revision, updated_at AS updatedAt,
    NULL AS room, NULL AS startsAt, NULL AS endsAt
    FROM program_sessions WHERE event_id = ? AND id = ? LIMIT 1`)
    .bind(eventId, sessionId).first<SessionRow & { updatedAt: string }>();
}

function sameSession(
  row: SessionRow,
  value: Pick<SessionContentUpdate, "title" | "abstract" | "track" | "format" | "durationMinutes">,
) {
  return row.title === value.title && row.abstract === value.abstract && row.track === value.track
    && row.format === value.format && row.durationMinutes === value.durationMinutes;
}

export async function updateSessionContent(
  database: Database,
  input: { eventId: string; sessionId: string; actorUserId: string; value: SessionContentUpdate; now: string },
) {
  const current = await readSession(database, input.eventId, input.sessionId);
  if (!current) throw new SpeakerContentNotFoundError();
  if (current.revision === input.value.expectedRevision + 1 && sameSession(current, input.value)) {
    throw new SpeakerContentConflictError();
  }
  if (current.revision !== input.value.expectedRevision) throw new SpeakerContentConflictError();
  if (sameSession(current, input.value)) throw new SpeakerContentNotAllowedError("NO_CHANGES");
  const historyId = crypto.randomUUID();
  await database.batch([
    database.prepare(`INSERT INTO session_content_history (
      id, event_id, program_session_id, action, title, abstract, track, format,
      duration_minutes, change_note, actor_user_id, created_at
    ) SELECT ?, event_id, id, 'updated', title, abstract, track, format,
      duration_minutes, ?, ?, ? FROM program_sessions
      WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      historyId, input.value.changeNote, input.actorUserId, input.now,
      input.eventId, input.sessionId, input.value.expectedRevision,
    ),
    database.prepare(`UPDATE program_sessions SET title = ?, abstract = ?, track = ?, format = ?,
      duration_minutes = ?, revision = revision + 1,
      updated_at = ${MONOTONIC_UPDATED_AT_SQL}
      WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      input.value.title, input.value.abstract, input.value.track, input.value.format,
      input.value.durationMinutes, input.now, input.now,
      input.eventId, input.sessionId, input.value.expectedRevision,
    ),
  ]);
  const history = await database.prepare(`SELECT history.id, history.program_session_id AS sessionId,
    history.action, history.title, history.abstract, history.track, history.format,
    history.duration_minutes AS durationMinutes, history.change_note AS changeNote,
    user.display_name AS actorName, history.created_at AS createdAt
    FROM session_content_history history INNER JOIN users user ON user.id = history.actor_user_id
    WHERE history.event_id = ? AND history.id = ? LIMIT 1`)
    .bind(input.eventId, historyId).first<HistoryRow>();
  if (!history) throw new SpeakerContentConflictError();
  return historyProjection(history);
}

export async function restoreSessionContent(
  database: Database,
  input: { eventId: string; sessionId: string; historyId: string; actorUserId: string; now: string },
) {
  const [current, target] = await Promise.all([
    readSession(database, input.eventId, input.sessionId),
    database.prepare(`SELECT history.id, history.program_session_id AS sessionId, history.action,
      history.title, history.abstract,
      track, format, duration_minutes AS durationMinutes, change_note AS changeNote,
      user.display_name AS actorName, history.created_at AS createdAt
      FROM session_content_history history
      INNER JOIN users user ON user.id = history.actor_user_id
      WHERE history.event_id = ? AND history.program_session_id = ? AND history.id = ? LIMIT 1`)
      .bind(input.eventId, input.sessionId, input.historyId).first<HistoryRow>(),
  ]);
  if (!current || !target) throw new SpeakerContentNotFoundError();
  if (sameSession(current, target)) return historyProjection(target);
  const auditId = crypto.randomUUID();
  await database.batch([
    database.prepare(`INSERT INTO session_content_history (
      id, event_id, program_session_id, action, title, abstract, track, format,
      duration_minutes, change_note, actor_user_id, created_at
    ) SELECT ?, event_id, id, 'restored', ?, ?, ?, ?, ?, ?, ?, ?
      FROM program_sessions WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      auditId, current.title, current.abstract, current.track,
      current.format, current.durationMinutes, `Restored history ${input.historyId}`,
      input.actorUserId, input.now, input.eventId, input.sessionId, current.revision,
    ),
    database.prepare(`UPDATE program_sessions SET title = ?, abstract = ?, track = ?, format = ?,
      duration_minutes = ?, revision = revision + 1,
      updated_at = ${MONOTONIC_UPDATED_AT_SQL}
      WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      target.title, target.abstract, target.track, target.format, target.durationMinutes,
      input.now, input.now, input.eventId, input.sessionId, current.revision,
    ),
  ]);
  const history = await database.prepare(`SELECT history.id, history.program_session_id AS sessionId,
    history.action, history.title, history.abstract, history.track, history.format,
    history.duration_minutes AS durationMinutes, history.change_note AS changeNote,
    user.display_name AS actorName, history.created_at AS createdAt
    FROM session_content_history history INNER JOIN users user ON user.id = history.actor_user_id
    WHERE history.event_id = ? AND history.id = ? LIMIT 1`)
    .bind(input.eventId, auditId).first<HistoryRow>();
  if (!history) throw new SpeakerContentConflictError();
  return historyProjection(history);
}

export async function restoreSpeakerProfile(
  database: Database,
  input: { eventId: string; speakerId: string; historyId: string; actorUserId: string; now: string },
) {
  const [current, target] = await Promise.all([
    speakerById(database, input.eventId, input.speakerId),
    database.prepare(`SELECT action, profile_json AS profileJson FROM speaker_content_history
      WHERE event_id = ? AND speaker_id = ? AND id = ? LIMIT 1`)
      .bind(input.eventId, input.speakerId, input.historyId).first<{ action: SpeakerHistoryRow["action"]; profileJson: string }>(),
  ]);
  if (!current || !target) throw new SpeakerContentNotFoundError();
  if (target.action === "headshot_uploaded") {
    throw new SpeakerContentNotAllowedError("RESTORE_NOT_ALLOWED");
  }
  const prior = decodeSpeakerHistorySnapshot(target.profileJson);
  if (!prior) throw new SpeakerContentDataIntegrityError();
  const slug = await eventSlug(database, input.eventId);
  const currentProfile = profileProjection(current, slug);
  const currentSnapshot = speakerHistorySnapshot(current, slug);
  const ready = profileReady({ ...prior, contactEmail: current.contactEmail ?? "" });
  if (prior.publicVisibility === "published" && !ready) {
    throw new SpeakerContentNotAllowedError("PROFILE_NOT_READY");
  }
  if (sameProfile(current, { ...prior, contactEmail: current.contactEmail ?? "" })) return currentProfile;
  const auditId = crypto.randomUUID();
  await database.batch([
    database.prepare(`INSERT INTO speaker_content_history (
      id, event_id, speaker_id, action, profile_json, change_note, actor_user_id, created_at
    ) SELECT ?, event_id, id, 'restored', ?, ?, ?, ? FROM speakers
      WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      auditId, JSON.stringify(currentSnapshot), `Restored history ${input.historyId}`,
      input.actorUserId, input.now, input.eventId, input.speakerId, current.revision,
    ),
    database.prepare(`UPDATE speakers SET name = ?, title = ?, company = ?,
      bio = ?, social_urls_json = ?, travel_preferences = ?, public_visibility = ?,
      profile_status = ?, revision = revision + 1, updated_at = ${MONOTONIC_UPDATED_AT_SQL}
      WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      prior.name, prior.title, prior.company, prior.bio,
      JSON.stringify(prior.socialUrls), prior.travelPreferences, prior.publicVisibility,
      ready ? "ready" : "incomplete", input.now, input.now,
      input.eventId, input.speakerId, current.revision,
    ),
  ]);
  const updated = await speakerById(database, input.eventId, input.speakerId);
  if (!updated || updated.revision !== current.revision + 1) throw new SpeakerContentConflictError();
  return profileProjection(updated, await eventSlug(database, input.eventId));
}

export async function updateSpeakerVisibility(
  database: Database,
  input: { eventId: string; speakerId: string; value: SpeakerVisibilityUpdate; now: string },
) {
  const current = await speakerById(database, input.eventId, input.speakerId);
  if (!current) throw new SpeakerContentNotFoundError();
  if (current.revision === input.value.revision + 1 && current.publicVisibility === input.value.publicVisibility) {
    return profileProjection(current, await eventSlug(database, input.eventId));
  }
  if (current.revision !== input.value.revision) throw new SpeakerContentConflictError();
  if (current.publicVisibility === input.value.publicVisibility) {
    return profileProjection(current, await eventSlug(database, input.eventId));
  }
  if (input.value.publicVisibility === "published" && current.profileStatus !== "ready") {
    throw new SpeakerContentNotAllowedError("PROFILE_NOT_READY");
  }
  const result = await database.prepare(`UPDATE speakers SET public_visibility = ?,
    revision = revision + 1, updated_at = ${MONOTONIC_UPDATED_AT_SQL}
    WHERE event_id = ? AND id = ? AND revision = ?`)
    .bind(input.value.publicVisibility, input.now, input.now,
      input.eventId, input.speakerId, input.value.revision).run();
  if (result.meta.changes < 1) throw new SpeakerContentConflictError();
  const updated = await speakerById(database, input.eventId, input.speakerId);
  if (!updated) throw new SpeakerContentNotFoundError();
  if (updated.revision !== input.value.revision + 1
    || updated.publicVisibility !== input.value.publicVisibility) {
    throw new SpeakerContentConflictError();
  }
  return profileProjection(updated, await eventSlug(database, input.eventId));
}

export async function updateSpeakerWorkflow(
  database: Database,
  input: { eventId: string; speakerId: string; value: SpeakerWorkflowUpdate; now: string },
) {
  const current = await speakerById(database, input.eventId, input.speakerId);
  if (!current) throw new SpeakerContentNotFoundError();
  if (current.revision === input.value.revision + 1 && current.workflowStatus === input.value.status) {
    return profileProjection(current, await eventSlug(database, input.eventId));
  }
  if (current.revision !== input.value.revision) throw new SpeakerContentConflictError();
  if (current.workflowStatus === input.value.status) {
    return profileProjection(current, await eventSlug(database, input.eventId));
  }
  const result = await database.prepare(`UPDATE speakers SET workflow_status = ?,
    revision = revision + 1, updated_at = ${MONOTONIC_UPDATED_AT_SQL}
    WHERE event_id = ? AND id = ? AND revision = ?`)
    .bind(input.value.status, input.now, input.now,
      input.eventId, input.speakerId, input.value.revision).run();
  if (result.meta.changes < 1) throw new SpeakerContentConflictError();
  const updated = await speakerById(database, input.eventId, input.speakerId);
  if (!updated) throw new SpeakerContentNotFoundError();
  if (updated.revision !== input.value.revision + 1 || updated.workflowStatus !== input.value.status) {
    throw new SpeakerContentConflictError();
  }
  return profileProjection(updated, await eventSlug(database, input.eventId));
}

export interface PrivateFileRow {
  eventId: string;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}

export async function approvedCurrentDeliverables(
  database: Database,
  eventId: string,
): Promise<DeliverableArchiveSource[]> {
  const result = await database.prepare(`SELECT version.event_id AS eventId,
    session.slug AS sessionSlug, session.title AS sessionTitle,
    request.request_key AS requestKey, request.label AS requestLabel,
    version.object_key AS objectKey, version.original_filename AS originalFilename,
    version.content_type AS contentType, version.byte_size AS byteSize,
    version.sha256, version.uploaded_at AS uploadedAt
    FROM deliverable_versions version
    INNER JOIN deliverable_requests request ON request.event_id = version.event_id
      AND request.id = version.request_id AND request.active = 1
    INNER JOIN program_sessions session ON session.event_id = version.event_id
      AND session.id = version.program_session_id
    INNER JOIN acceptances acceptance ON acceptance.event_id = version.event_id
      AND acceptance.program_session_id = version.program_session_id
    WHERE version.event_id = ?
      AND version.version_number = (
        SELECT MAX(latest.version_number) FROM deliverable_versions latest
        WHERE latest.event_id = version.event_id AND latest.request_id = version.request_id
      )
      AND (
        SELECT review.outcome FROM content_reviews review
        WHERE review.event_id = version.event_id AND review.version_id = version.id
        ORDER BY review.reviewed_at DESC, review.id DESC LIMIT 1
      ) = 'approved'
    ORDER BY session.title COLLATE NOCASE, session.id,
      request.label COLLATE NOCASE, request.id`).bind(eventId).all<DeliverableArchiveSource>();
  return result.results;
}

export async function privateFileIsReferenced(
  database: Database,
  eventId: string,
  objectKey: string,
) {
  const row = await database.prepare(`SELECT CASE WHEN
      EXISTS (SELECT 1 FROM speakers
        WHERE event_id = ? AND headshot_object_key = ?)
      OR EXISTS (SELECT 1 FROM deliverable_versions
        WHERE event_id = ? AND object_key = ?)
    THEN 1 ELSE 0 END AS referenced`)
    .bind(eventId, objectKey, eventId, objectKey)
    .first<{ referenced: number }>();
  if (!row || (row.referenced !== 0 && row.referenced !== 1)) {
    throw new SpeakerContentDataIntegrityError();
  }
  return row.referenced === 1;
}

export async function authorizedDeliverableFile(
  database: Database,
  input: { eventId: string; versionId: string; userId?: string; organizer?: boolean },
) {
  const row = await database.prepare(`SELECT version.event_id AS eventId, version.object_key AS objectKey,
    version.original_filename AS originalFilename, version.content_type AS contentType,
    version.byte_size AS byteSize, version.sha256
    FROM deliverable_versions version
    WHERE version.event_id = ? AND version.id = ? AND (
      ? = 1 OR (? = 1 AND EXISTS (
        SELECT 1 FROM session_presenters presenter
        INNER JOIN speakers speaker ON speaker.event_id = presenter.event_id
          AND speaker.id = presenter.speaker_id
        WHERE presenter.event_id = version.event_id
          AND presenter.program_session_id = version.program_session_id
          AND speaker.user_id = ?
      ))
    ) LIMIT 1`).bind(
      input.eventId,
      input.versionId,
      input.organizer ? 1 : 0,
      input.userId ? 1 : 0,
      input.userId ?? null,
    )
    .first<PrivateFileRow>();
  if (!row) throw new SpeakerContentNotFoundError();
  return row;
}

export async function headshotFile(
  database: Database,
  input: { eventId?: string; eventSlug?: string; speakerId?: string; speakerSlug?: string; userId?: string; organizer?: boolean; public?: boolean },
) {
  const row = await database.prepare(`SELECT speaker.event_id AS eventId, speaker.headshot_object_key AS objectKey,
    speaker.headshot_original_filename AS originalFilename,
    speaker.headshot_content_type AS contentType, speaker.headshot_byte_size AS byteSize,
    speaker.headshot_sha256 AS sha256
    FROM speakers speaker INNER JOIN events event ON event.id = speaker.event_id
    WHERE (? IS NULL OR speaker.event_id = ?) AND (? IS NULL OR event.slug = ?)
      AND (? IS NULL OR speaker.id = ?) AND (? IS NULL OR speaker.slug = ?)
      AND speaker.headshot_object_key IS NOT NULL
      AND (
        ? = 1 AND event.status = 'published' AND speaker.public_visibility = 'published'
        OR ? = 1
        OR (? = 1 AND speaker.user_id = ?)
      ) LIMIT 1`).bind(
        input.eventId ?? null, input.eventId ?? null,
        input.eventSlug ?? null, input.eventSlug ?? null,
        input.speakerId ?? null, input.speakerId ?? null,
        input.speakerSlug ?? null, input.speakerSlug ?? null,
        input.public ? 1 : 0, input.organizer ? 1 : 0,
        input.userId ? 1 : 0, input.userId ?? null,
      ).first<PrivateFileRow>();
  if (!row) throw new SpeakerContentNotFoundError();
  return row;
}

export async function speakerForUpload(
  database: Database,
  input: { eventId: string; userId?: string; speakerId?: string },
) {
  const row = input.speakerId
    ? await speakerById(database, input.eventId, input.speakerId)
    : await ownedSpeaker(database, input.eventId, input.userId!);
  if (!row) throw new SpeakerContentNotFoundError();
  return row;
}

export async function finalizeHeadshot(
  database: Database,
  input: {
    eventId: string; speakerId: string; expectedRevision: number; actorUserId?: string;
    file: PrivateFileRow; now: string;
  },
) {
  const current = await speakerById(database, input.eventId, input.speakerId);
  if (!current || current.revision !== input.expectedRevision) throw new SpeakerContentConflictError();
  const ready = [current.name, current.contactEmail, current.title, current.company, current.bio]
    .every((value) => typeof value === "string" && value.trim().length > 0);
  const update = database.prepare(`UPDATE speakers SET headshot_object_key = ?,
    headshot_original_filename = ?, headshot_content_type = ?, headshot_byte_size = ?,
    headshot_sha256 = ?, headshot_uploaded_at = ?, profile_status = ?,
    revision = revision + 1, updated_at = ${MONOTONIC_UPDATED_AT_SQL}
    WHERE event_id = ? AND id = ? AND revision = ?`).bind(
      input.file.objectKey, input.file.originalFilename, input.file.contentType,
      input.file.byteSize, input.file.sha256, input.now, ready ? "ready" : "incomplete",
      input.now, input.now, input.eventId, input.speakerId, input.expectedRevision,
    );
  if (input.actorUserId) {
    const snapshot = speakerHistorySnapshot(current, await eventSlug(database, input.eventId));
    await database.batch([
      database.prepare(`INSERT INTO speaker_content_history (
        id, event_id, speaker_id, action, profile_json, change_note, actor_user_id, created_at
      ) SELECT ?, event_id, id, 'headshot_uploaded', ?, 'Uploaded a new headshot', ?, ?
        FROM speakers WHERE event_id = ? AND id = ? AND revision = ?`)
        .bind(crypto.randomUUID(), JSON.stringify(snapshot), input.actorUserId, input.now,
          input.eventId, input.speakerId, input.expectedRevision),
      update,
    ]);
  } else {
    const result = await update.run();
    if (result.meta.changes < 1) throw new SpeakerContentConflictError();
  }
  const updated = await speakerById(database, input.eventId, input.speakerId);
  if (!updated) throw new SpeakerContentNotFoundError();
  if (updated.revision !== input.expectedRevision + 1
    || updated.headshotObjectKey !== input.file.objectKey) throw new SpeakerContentConflictError();
  return profileProjection(updated, await eventSlug(database, input.eventId), input.actorUserId ? "organizer" : "speaker");
}

export async function uploadSource(
  database: Database,
  input: { eventId: string; requestId: string; userId: string; idempotencyKey: string },
) {
  const canonical = await database.prepare(`SELECT version.id, version.request_id AS requestId,
    version.program_session_id AS sessionId, request.request_type AS requestType,
    version.version_number AS versionNumber, version.original_filename AS originalFilename,
    version.object_key AS objectKey, version.content_type AS contentType,
    version.byte_size AS byteSize, version.sha256, version.note,
    version.uploaded_by_speaker_id AS uploaderSpeakerId, speaker.name AS uploaderName,
    version.uploaded_at AS uploadedAt FROM deliverable_versions version
    INNER JOIN deliverable_requests request ON request.event_id = version.event_id AND request.id = version.request_id
    INNER JOIN speakers speaker ON speaker.event_id = version.event_id AND speaker.id = version.uploaded_by_speaker_id
    WHERE version.event_id = ? AND version.request_id = ? AND version.idempotency_key = ? LIMIT 1`)
    .bind(input.eventId, input.requestId, input.idempotencyKey).first<VersionRow>();
  const source = await database.prepare(`SELECT request.id, request.program_session_id AS sessionId,
    request.request_type AS requestType, request.allowed_content_types_json AS allowedContentTypesJson,
    request.max_bytes AS maxBytes, speaker.id AS speakerId, speaker.name AS speakerName,
    session.revision AS sessionRevision, session.updated_at AS sessionUpdatedAt,
    COALESCE((SELECT MAX(version_number) + 1 FROM deliverable_versions
      WHERE event_id = request.event_id AND request_id = request.id), 1) AS nextVersion
    FROM deliverable_requests request
    INNER JOIN program_sessions session ON session.event_id = request.event_id AND session.id = request.program_session_id
    INNER JOIN session_presenters presenter ON presenter.event_id = request.event_id
      AND presenter.program_session_id = request.program_session_id
    INNER JOIN speakers speaker ON speaker.event_id = presenter.event_id
      AND speaker.id = presenter.speaker_id AND speaker.user_id = ?
    WHERE request.event_id = ? AND request.id = ? AND request.active = 1 LIMIT 1`)
    .bind(input.userId, input.eventId, input.requestId).first<{
      id: string; sessionId: string; requestType: "presentation";
      allowedContentTypesJson: string; maxBytes: number; speakerId: string; speakerName: string;
      sessionRevision: number; sessionUpdatedAt: string; nextVersion: number;
    }>();
  if (!source) throw new SpeakerContentNotFoundError();
  return { canonical, source, allowedContentTypes: parseArray(source.allowedContentTypesJson) };
}

export async function finalizeDeliverableVersion(
  database: Database,
  input: {
    eventId: string; requestId: string; idempotencyKey: string; note: string;
    source: Awaited<ReturnType<typeof uploadSource>>["source"];
    file: PrivateFileRow; now: string;
  },
) {
  const id = crypto.randomUUID();
  let result: DatabaseResult;
  try {
    result = await database.prepare(`INSERT INTO deliverable_versions (
      id, event_id, request_id, program_session_id, uploaded_by_speaker_id,
      version_number, idempotency_key, original_filename, object_key, content_type,
      byte_size, sha256, note, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        id, input.eventId, input.requestId, input.source.sessionId, input.source.speakerId,
        input.source.nextVersion, input.idempotencyKey, input.file.originalFilename,
        input.file.objectKey, input.file.contentType, input.file.byteSize, input.file.sha256,
        input.note, input.now,
      ).run();
  } catch (error) {
    const canonical = await database.prepare(`SELECT version.id, version.request_id AS requestId,
      version.program_session_id AS sessionId, request.request_type AS requestType,
      version.version_number AS versionNumber, version.original_filename AS originalFilename,
      version.object_key AS objectKey, version.content_type AS contentType,
      version.byte_size AS byteSize, version.sha256, version.note,
      version.uploaded_by_speaker_id AS uploaderSpeakerId, speaker.name AS uploaderName,
      version.uploaded_at AS uploadedAt FROM deliverable_versions version
      INNER JOIN deliverable_requests request ON request.event_id = version.event_id AND request.id = version.request_id
      INNER JOIN speakers speaker ON speaker.event_id = version.event_id AND speaker.id = version.uploaded_by_speaker_id
      WHERE version.event_id = ? AND version.request_id = ? AND version.idempotency_key = ? LIMIT 1`)
      .bind(input.eventId, input.requestId, input.idempotencyKey).first<VersionRow>();
    if (canonical) {
      throw new SpeakerContentCanonicalUploadError(canonical,
        canonical.originalFilename === input.file.originalFilename
        && canonical.contentType === input.file.contentType
        && canonical.byteSize === input.file.byteSize
        && canonical.sha256 === input.file.sha256
        && canonical.note === input.note);
    }
    throw error;
  }
  // D1 includes trigger-side session readiness updates in meta.changes. The
  // successful INSERT may therefore report more than one changed row; the
  // canonical row lookup below remains the source-of-truth verification.
  if (result.meta.changes < 1) throw new SpeakerContentConflictError();
  const row = await database.prepare(`SELECT version.id, version.request_id AS requestId,
    version.program_session_id AS sessionId, request.request_type AS requestType,
    version.version_number AS versionNumber, version.original_filename AS originalFilename,
    version.object_key AS objectKey, version.content_type AS contentType,
    version.byte_size AS byteSize, version.sha256, version.note,
    version.uploaded_by_speaker_id AS uploaderSpeakerId, speaker.name AS uploaderName,
    version.uploaded_at AS uploadedAt FROM deliverable_versions version
    INNER JOIN deliverable_requests request ON request.event_id = version.event_id AND request.id = version.request_id
    INNER JOIN speakers speaker ON speaker.event_id = version.event_id AND speaker.id = version.uploaded_by_speaker_id
    WHERE version.event_id = ? AND version.id = ? LIMIT 1`)
    .bind(input.eventId, id).first<VersionRow>();
  if (!row) throw new SpeakerContentNotFoundError();
  return row;
}

export async function deliverableUploadProjection(
  database: Database,
  eventId: string,
  row: VersionRow,
) {
  const [slug, session] = await Promise.all([
    eventSlug(database, eventId),
    readSession(database, eventId, row.sessionId),
  ]);
  if (!session) throw new SpeakerContentNotFoundError();
  return {
    version: versionProjection(row, slug, "speaker"),
    session: {
      id: session.id,
      deliverablesStatus: session.deliverablesStatus,
      approvalStatus: session.approvalStatus,
      revision: session.revision,
    },
  };
}
