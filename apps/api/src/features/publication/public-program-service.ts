import {
  embedFiltersSchema,
  type EmbedAppearance,
  type EmbedConfigCreate,
  type EmbedConfigResponse,
  type EmbedConfigUpdate,
  type EmbedFilters,
  type PublicEmbedResponse,
  type PublicProgramResponse,
} from "@confpilot/contracts";
import type { Database } from "../../runtime/database";

interface EventRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  location: string;
  description: string;
  startsOn: string;
  endsOn: string;
  timeZone: string;
  status: "published";
}

interface SessionRow {
  slug: string;
  title: string;
  abstract: string;
  track: string;
  format: PublicProgramResponse["sessions"][number]["format"];
  durationMinutes: number;
  publicationStatus: "published";
  dayNumber: number;
  date: string;
  label: string;
  room: string;
  startsAt: string;
  endsAt: string;
}

interface PresenterRow {
  sessionSlug: string;
  sessionTitle: string;
  sessionTrack: string;
  sessionFormat: PublicProgramResponse["sessions"][number]["format"];
  role: "primary" | "co_presenter";
  slug: string;
  name: string;
  title: string;
  company: string;
  bio: string;
  headshotUrl: string | null;
  headshotObjectKey: string | null;
  headshotSha256: string | null;
  headshotFallback: string;
  publicVisibility: "published";
}

function publicHeadshotUrl(eventSlug: string, speaker: PresenterRow) {
  if (speaker.headshotObjectKey && speaker.headshotSha256) {
    return `/api/public/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speaker.slug)}/headshot?v=${speaker.headshotSha256.slice(0, 12)}`;
  }
  return speaker.headshotUrl;
}

interface EmbedRow {
  id: string;
  eventSlug: string;
  slug: string;
  name: string;
  view: EmbedConfigResponse["view"];
  filtersJson: string;
  outputFormat: EmbedConfigResponse["outputFormat"];
  theme: EmbedAppearance["theme"];
  accentColor: string;
  density: EmbedAppearance["density"];
  showSearch: number;
  showFilters: number;
  showEventSummary: number;
  enabled: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

const nameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function surnameKey(name: string) {
  const parts = name.trim().split(/\s+/);
  const trailingOperationalId = parts.length > 1 && /^(?=.*\d)(?=.*[a-f])[a-f\d]{7,40}$/i.test(parts.at(-1) ?? "");
  return parts.at(trailingOperationalId ? -2 : -1) ?? name;
}

function comparePublicSpeakers(
  left: { name: string; slug: string },
  right: { name: string; slug: string },
) {
  return nameCollator.compare(surnameKey(left.name), surnameKey(right.name))
    || nameCollator.compare(left.name, right.name)
    || nameCollator.compare(left.slug, right.slug)
    || (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0);
}

function publicSpeakerInitials(name: string, storedFallback: string) {
  const stored = storedFallback.trim();
  if (/\p{L}|\p{N}/u.test(stored)) return stored;
  const derived = name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => {
      const initial = Array.from(part).find((character) => /\p{L}|\p{N}/u.test(character));
      return initial ? Array.from(initial.toUpperCase())[0] ?? "" : "";
    })
    .join("");
  return /\p{L}|\p{N}/u.test(derived) ? derived : "SP";
}

// Every public projection starts from this exact eligibility relation. A new
// public surface cannot accidentally bypass one of the publication gates.
const ELIGIBLE_SESSIONS_CTE = `WITH eligible_sessions AS (
  SELECT
    session.id AS session_id,
    session.event_id AS event_id,
    session.slug AS slug,
    session.title AS title,
    session.abstract AS abstract,
    session.track AS track,
    session.format AS format,
    session.duration_minutes AS durationMinutes,
    session.publication_status AS publicationStatus,
    event_day.day_number AS dayNumber,
    event_day.date AS date,
    event_day.label AS label,
    room.name AS room,
    room.sort_order AS roomSortOrder,
    placement.starts_at AS startsAt,
    placement.ends_at AS endsAt
  FROM events AS event
  INNER JOIN schedule_placements AS placement
    ON placement.event_id = event.id
  INNER JOIN program_sessions AS session
    ON session.id = placement.program_session_id
    AND session.event_id = placement.event_id
  INNER JOIN acceptances AS acceptance
    ON acceptance.program_session_id = session.id
    AND acceptance.event_id = session.event_id
  INNER JOIN session_presenters AS primary_presenter
    ON primary_presenter.program_session_id = session.id
    AND primary_presenter.event_id = session.event_id
    AND primary_presenter.role = 'primary'
  INNER JOIN speakers AS primary_speaker
    ON primary_speaker.id = primary_presenter.speaker_id
    AND primary_speaker.event_id = primary_presenter.event_id
  INNER JOIN event_days AS event_day
    ON event_day.id = placement.event_day_id
    AND event_day.event_id = placement.event_id
  INNER JOIN rooms AS room
    ON room.id = placement.room_id
    AND room.event_id = placement.event_id
  WHERE event.slug = ?
    AND event.status = 'published'
    AND session.approval_status = 'approved'
    AND session.publication_status = 'published'
    AND primary_speaker.public_visibility = 'published'
    AND EXISTS (
      SELECT 1 FROM session_deliverable_readiness AS readiness
      WHERE readiness.event_id = session.event_id
        AND readiness.program_session_id = session.id
        AND readiness.deliverables_status = 'ready'
    )
    AND NOT EXISTS (
      SELECT 1 FROM speaker_tasks AS task
      WHERE task.event_id = session.event_id
        AND task.program_session_id = session.id
        AND task.state = 'open'
    )
    AND NOT EXISTS (
      SELECT 1 FROM session_presenters AS presenter
      INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
        AND speaker.id = presenter.speaker_id
      WHERE presenter.event_id = session.event_id
        AND presenter.program_session_id = session.id
        AND (speaker.workflow_status != 'confirmed'
          OR speaker.profile_status != 'ready'
          OR speaker.agreement_status != 'signed')
    )
    AND NOT EXISTS (
      SELECT 1 FROM session_presenters AS current_presenter
      INNER JOIN session_presenters AS conflicting_presenter
        ON conflicting_presenter.event_id = current_presenter.event_id
        AND conflicting_presenter.speaker_id = current_presenter.speaker_id
        AND conflicting_presenter.program_session_id != current_presenter.program_session_id
      INNER JOIN schedule_placements AS conflicting_placement
        ON conflicting_placement.event_id = conflicting_presenter.event_id
        AND conflicting_placement.program_session_id = conflicting_presenter.program_session_id
      INNER JOIN program_sessions AS conflicting_session
        ON conflicting_session.event_id = conflicting_presenter.event_id
        AND conflicting_session.id = conflicting_presenter.program_session_id
        AND conflicting_session.approval_status = 'approved'
        AND conflicting_session.publication_status = 'published'
      INNER JOIN session_presenters AS conflicting_primary_presenter
        ON conflicting_primary_presenter.event_id = conflicting_session.event_id
        AND conflicting_primary_presenter.program_session_id = conflicting_session.id
        AND conflicting_primary_presenter.role = 'primary'
      INNER JOIN speakers AS conflicting_primary_speaker
        ON conflicting_primary_speaker.event_id = conflicting_primary_presenter.event_id
        AND conflicting_primary_speaker.id = conflicting_primary_presenter.speaker_id
        AND conflicting_primary_speaker.public_visibility = 'published'
      INNER JOIN acceptances AS conflicting_acceptance
        ON conflicting_acceptance.event_id = conflicting_presenter.event_id
        AND conflicting_acceptance.program_session_id = conflicting_presenter.program_session_id
      WHERE current_presenter.event_id = session.event_id
        AND current_presenter.program_session_id = session.id
        AND EXISTS (
          SELECT 1 FROM session_deliverable_readiness AS conflicting_readiness
          WHERE conflicting_readiness.event_id = conflicting_session.event_id
            AND conflicting_readiness.program_session_id = conflicting_session.id
            AND conflicting_readiness.deliverables_status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM speaker_tasks AS conflicting_task
          WHERE conflicting_task.event_id = conflicting_session.event_id
            AND conflicting_task.program_session_id = conflicting_session.id
            AND conflicting_task.state = 'open'
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_presenters AS presenter
          INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
            AND speaker.id = presenter.speaker_id
          WHERE presenter.event_id = conflicting_session.event_id
            AND presenter.program_session_id = conflicting_session.id
            AND (speaker.workflow_status != 'confirmed'
              OR speaker.profile_status != 'ready'
              OR speaker.agreement_status != 'signed')
        )
        AND placement.starts_at < conflicting_placement.ends_at
        AND conflicting_placement.starts_at < placement.ends_at
    )
)`;

const EMPTY_FILTERS: EmbedFilters = { days: [], tracks: [], formats: [], rooms: [] };

export class PublicEventNotFoundError extends Error {}
export class EmbedNotFoundError extends Error {}
export class EmbedConflictError extends Error {}

function filtersJson(filters: EmbedFilters) {
  return JSON.stringify(filters);
}

function embedPaths(eventSlug: string, embedSlug: string) {
  const event = encodeURIComponent(eventSlug);
  const embed = encodeURIComponent(embedSlug);
  return {
    publicPath: `/embed/${event}/${embed}`,
    jsonPath: `/api/public/events/${event}/embeds/${embed}`,
    calendarPath: `/api/public/events/${event}/embeds/${embed}/calendar.ics`,
  };
}

function parseFilters(value: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("Stored embed filters are not valid JSON");
  }
  return embedFiltersSchema.parse(decoded);
}

function toEmbed(row: EmbedRow): EmbedConfigResponse {
  return {
    id: row.id,
    eventSlug: row.eventSlug,
    slug: row.slug,
    name: row.name,
    view: row.view,
    filters: parseFilters(row.filtersJson),
    outputFormat: row.outputFormat,
    appearance: {
      theme: row.theme,
      accentColor: row.accentColor,
      density: row.density,
      showSearch: row.showSearch === 1,
      showFilters: row.showFilters === 1,
      showEventSummary: row.showEventSummary === 1,
    },
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...embedPaths(row.eventSlug, row.slug),
  };
}

function sameEmbedState(row: EmbedRow, input: EmbedConfigCreate | EmbedConfigUpdate) {
  return row.name === input.name
    && row.view === input.view
    && filtersJson(parseFilters(row.filtersJson)) === filtersJson(input.filters)
    && row.outputFormat === input.outputFormat
    && row.theme === input.appearance.theme
    && row.accentColor === input.appearance.accentColor
    && row.density === input.appearance.density
    && (row.showSearch === 1) === input.appearance.showSearch
    && (row.showFilters === 1) === input.appearance.showFilters
    && (row.showEventSummary === 1) === input.appearance.showEventSummary
    && (row.enabled === 1) === input.enabled;
}

function sessionMatchesFilters(session: SessionRow, filters: EmbedFilters) {
  return (filters.days.length === 0 || filters.days.includes(session.date))
    && (filters.tracks.length === 0 || filters.tracks.includes(session.track))
    && (filters.formats.length === 0 || filters.formats.includes(session.format))
    && (filters.rooms.length === 0 || filters.rooms.includes(session.room));
}

export async function getPublicProgram(
  database: Database,
  eventSlug: string,
  filters: EmbedFilters = EMPTY_FILTERS,
): Promise<PublicProgramResponse> {
  const event = await database.prepare(
    `SELECT
      id,
      slug,
      name,
      tagline,
      location,
      description,
      starts_on AS startsOn,
      ends_on AS endsOn,
      time_zone AS timeZone,
      status
    FROM events
    WHERE slug = ?
      AND status = 'published'
    LIMIT 1`,
  ).bind(eventSlug).first<EventRow>();
  if (!event) throw new PublicEventNotFoundError();

  const { results: sessionRows } = await database.prepare(
    `${ELIGIBLE_SESSIONS_CTE}
    SELECT
      slug, title, abstract, track, format, durationMinutes, publicationStatus,
      dayNumber, date, label, room, startsAt, endsAt
    FROM eligible_sessions
    ORDER BY startsAt ASC, roomSortOrder ASC, slug ASC`,
  ).bind(eventSlug).all<SessionRow>();

  const selectedSessions = sessionRows.filter((session) => sessionMatchesFilters(session, filters));
  const selectedSlugs = new Set(selectedSessions.map((session) => session.slug));

  const { results: presenterRows } = await database.prepare(
    `${ELIGIBLE_SESSIONS_CTE}
    SELECT
      eligible.slug AS sessionSlug,
      eligible.title AS sessionTitle,
      eligible.track AS sessionTrack,
      eligible.format AS sessionFormat,
      presenter.role AS role,
      speaker.slug AS slug,
      speaker.name AS name,
      speaker.title AS title,
      speaker.company AS company,
      speaker.bio AS bio,
      speaker.headshot_url AS headshotUrl,
      speaker.headshot_object_key AS headshotObjectKey,
      speaker.headshot_sha256 AS headshotSha256,
      speaker.headshot_fallback AS headshotFallback,
      speaker.public_visibility AS publicVisibility
    FROM eligible_sessions AS eligible
    INNER JOIN session_presenters AS presenter
      ON presenter.program_session_id = eligible.session_id
      AND presenter.event_id = eligible.event_id
    INNER JOIN speakers AS speaker
      ON speaker.id = presenter.speaker_id
      AND speaker.event_id = presenter.event_id
    WHERE speaker.public_visibility = 'published'
    ORDER BY eligible.startsAt ASC,
      CASE presenter.role WHEN 'primary' THEN 0 ELSE 1 END ASC,
      speaker.name COLLATE NOCASE ASC,
      speaker.slug ASC`,
  ).bind(eventSlug).all<PresenterRow>();
  const publicPresenters = presenterRows.filter((presenter) => selectedSlugs.has(presenter.sessionSlug));

  const presentersBySession = new Map<string, PresenterRow[]>();
  for (const presenter of publicPresenters) {
    const presenters = presentersBySession.get(presenter.sessionSlug) ?? [];
    presenters.push(presenter);
    presentersBySession.set(presenter.sessionSlug, presenters);
  }

  const sessions = selectedSessions.map((session) => ({
    slug: session.slug,
    title: session.title,
    abstract: session.abstract,
    track: session.track,
    format: session.format,
    durationMinutes: session.durationMinutes,
    publicationStatus: session.publicationStatus,
    schedule: {
      dayNumber: session.dayNumber,
      date: session.date,
      label: session.label,
      room: session.room,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
    },
    speakers: (presentersBySession.get(session.slug) ?? []).map((speaker) => ({
      slug: speaker.slug,
      name: speaker.name,
      title: speaker.title,
      company: speaker.company,
      headshotUrl: publicHeadshotUrl(eventSlug, speaker),
      headshotFallback: publicSpeakerInitials(speaker.name, speaker.headshotFallback),
    })),
  }));

  const speakerMap = new Map<string, PublicProgramResponse["speakers"][number]>();
  for (const speaker of publicPresenters) {
    const existing = speakerMap.get(speaker.slug);
    const session = {
      slug: speaker.sessionSlug,
      title: speaker.sessionTitle,
      track: speaker.sessionTrack,
      format: speaker.sessionFormat,
    };
    if (existing) {
      existing.sessions.push(session);
    } else {
      speakerMap.set(speaker.slug, {
        slug: speaker.slug,
        name: speaker.name,
        title: speaker.title,
        company: speaker.company,
        bio: speaker.bio,
        headshotUrl: publicHeadshotUrl(eventSlug, speaker),
        headshotFallback: publicSpeakerInitials(speaker.name, speaker.headshotFallback),
        publicVisibility: speaker.publicVisibility,
        sessions: [session],
      });
    }
  }

  const program = {
    event: {
      slug: event.slug,
      name: event.name,
      tagline: event.tagline,
      location: event.location,
      description: event.description,
      startsOn: event.startsOn,
      endsOn: event.endsOn,
      timeZone: event.timeZone,
      status: event.status,
    },
    sessions,
    speakers: [...speakerMap.values()].sort(comparePublicSpeakers),
  } satisfies PublicProgramResponse;

  return program;
}

const EMBED_COLUMNS = `
  embed.id AS id,
  event.slug AS eventSlug,
  embed.slug AS slug,
  embed.name AS name,
  embed.view AS view,
  embed.filters_json AS filtersJson,
  embed.output_format AS outputFormat,
  embed.theme AS theme,
  embed.accent_color AS accentColor,
  embed.density AS density,
  embed.show_search AS showSearch,
  embed.show_filters AS showFilters,
  embed.show_event_summary AS showEventSummary,
  embed.enabled AS enabled,
  embed.revision AS revision,
  embed.created_at AS createdAt,
  embed.updated_at AS updatedAt`;

export async function listEmbedConfigs(database: Database, eventId: string) {
  const { results } = await database.prepare(
    `SELECT ${EMBED_COLUMNS}
    FROM public_embed_configs AS embed
    INNER JOIN events AS event ON event.id = embed.event_id
    WHERE embed.event_id = ?
    ORDER BY embed.name COLLATE NOCASE ASC, embed.slug ASC`,
  ).bind(eventId).all<EmbedRow>();
  return { embeds: results.map(toEmbed) };
}

export async function createEmbedConfig(
  database: Database,
  input: {
    eventId: string;
    actorUserId: string;
    value: EmbedConfigCreate;
    now: string;
  },
): Promise<{ embed: EmbedConfigResponse; created: boolean }> {
  const existing = await database.prepare(
    `SELECT ${EMBED_COLUMNS}
    FROM public_embed_configs AS embed
    INNER JOIN events AS event ON event.id = embed.event_id
    WHERE embed.event_id = ? AND embed.slug = ?
    LIMIT 1`,
  ).bind(input.eventId, input.value.slug).first<EmbedRow>();
  if (existing) {
    if (!sameEmbedState(existing, input.value)) throw new EmbedConflictError();
    return { embed: toEmbed(existing), created: false };
  }

  const id = crypto.randomUUID();
  try {
    await database.prepare(
      `INSERT INTO public_embed_configs (
        id, event_id, slug, name, view, filters_json, output_format, theme,
        accent_color, density, show_search, show_filters, show_event_summary,
        enabled, revision,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.eventId,
      input.value.slug,
      input.value.name,
      input.value.view,
      filtersJson(input.value.filters),
      input.value.outputFormat,
      input.value.appearance.theme,
      input.value.appearance.accentColor,
      input.value.appearance.density,
      input.value.appearance.showSearch ? 1 : 0,
      input.value.appearance.showFilters ? 1 : 0,
      input.value.appearance.showEventSummary ? 1 : 0,
      input.value.enabled ? 1 : 0,
      input.actorUserId,
      input.actorUserId,
      input.now,
      input.now,
    ).run();
  } catch (error) {
    const raced = await database.prepare(
      `SELECT ${EMBED_COLUMNS}
      FROM public_embed_configs AS embed
      INNER JOIN events AS event ON event.id = embed.event_id
      WHERE embed.event_id = ? AND embed.slug = ?
      LIMIT 1`,
    ).bind(input.eventId, input.value.slug).first<EmbedRow>();
    if (!raced) throw error;
    if (!sameEmbedState(raced, input.value)) throw new EmbedConflictError();
    return { embed: toEmbed(raced), created: false };
  }

  const created = await database.prepare(
    `SELECT ${EMBED_COLUMNS}
    FROM public_embed_configs AS embed
    INNER JOIN events AS event ON event.id = embed.event_id
    WHERE embed.event_id = ? AND embed.id = ?
    LIMIT 1`,
  ).bind(input.eventId, id).first<EmbedRow>();
  if (!created) throw new Error("Created embed could not be read");
  return { embed: toEmbed(created), created: true };
}

export async function updateEmbedConfig(
  database: Database,
  input: {
    eventId: string;
    embedId: string;
    actorUserId: string;
    value: EmbedConfigUpdate;
    now: string;
  },
): Promise<EmbedConfigResponse> {
  const existing = await database.prepare(
    `SELECT ${EMBED_COLUMNS}
    FROM public_embed_configs AS embed
    INNER JOIN events AS event ON event.id = embed.event_id
    WHERE embed.event_id = ? AND embed.id = ?
    LIMIT 1`,
  ).bind(input.eventId, input.embedId).first<EmbedRow>();
  if (!existing) throw new EmbedNotFoundError();

  if (existing.revision === input.value.revision + 1 && sameEmbedState(existing, input.value)) {
    return toEmbed(existing);
  }
  if (existing.revision !== input.value.revision) throw new EmbedConflictError();
  if (sameEmbedState(existing, input.value)) return toEmbed(existing);

  const result = await database.prepare(
    `UPDATE public_embed_configs
    SET name = ?, view = ?, filters_json = ?, output_format = ?, theme = ?,
      accent_color = ?, density = ?, show_search = ?, show_filters = ?,
      show_event_summary = ?, enabled = ?, revision = revision + 1,
      updated_by_user_id = ?,
      updated_at = CASE WHEN ? > updated_at THEN ?
        ELSE strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second') END
    WHERE event_id = ? AND id = ? AND revision = ?`,
  ).bind(
    input.value.name,
    input.value.view,
    filtersJson(input.value.filters),
    input.value.outputFormat,
    input.value.appearance.theme,
    input.value.appearance.accentColor,
    input.value.appearance.density,
    input.value.appearance.showSearch ? 1 : 0,
    input.value.appearance.showFilters ? 1 : 0,
    input.value.appearance.showEventSummary ? 1 : 0,
    input.value.enabled ? 1 : 0,
    input.actorUserId,
    input.now,
    input.now,
    input.eventId,
    input.embedId,
    input.value.revision,
  ).run();
  if (result.meta.changes !== 1) {
    const raced = await database.prepare(
      `SELECT ${EMBED_COLUMNS}
      FROM public_embed_configs AS embed
      INNER JOIN events AS event ON event.id = embed.event_id
      WHERE embed.event_id = ? AND embed.id = ?
      LIMIT 1`,
    ).bind(input.eventId, input.embedId).first<EmbedRow>();
    if (
      raced
      && raced.revision === input.value.revision + 1
      && sameEmbedState(raced, input.value)
    ) return toEmbed(raced);
    throw new EmbedConflictError();
  }

  const updated = await database.prepare(
    `SELECT ${EMBED_COLUMNS}
    FROM public_embed_configs AS embed
    INNER JOIN events AS event ON event.id = embed.event_id
    WHERE embed.event_id = ? AND embed.id = ?
    LIMIT 1`,
  ).bind(input.eventId, input.embedId).first<EmbedRow>();
  if (!updated) throw new EmbedNotFoundError();
  return toEmbed(updated);
}

export async function getPublicEmbed(
  database: Database,
  eventSlug: string,
  embedSlug: string,
): Promise<PublicEmbedResponse> {
  const embed = await database.prepare(
    `SELECT ${EMBED_COLUMNS}
    FROM public_embed_configs AS embed
    INNER JOIN events AS event ON event.id = embed.event_id
    WHERE event.slug = ?
      AND event.status = 'published'
      AND embed.slug = ?
      AND embed.enabled = 1
    LIMIT 1`,
  ).bind(eventSlug, embedSlug).first<EmbedRow>();
  if (!embed) throw new EmbedNotFoundError();
  const config = toEmbed(embed);
  return {
    embed: {
      slug: config.slug,
      name: config.name,
      view: config.view,
      filters: config.filters,
      appearance: config.appearance,
      revision: config.revision,
    },
    program: await getPublicProgram(database, eventSlug, config.filters),
  };
}
