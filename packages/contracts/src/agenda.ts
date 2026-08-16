import { z } from "zod";

import { sessionFormatSchema } from "./session-format";

const agendaIdSchema = z.string().trim().min(1).max(128);
const agendaSlugSchema = z.string().trim().min(1).max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase kebab-case slug");
const agendaTimestampSchema = z.iso.datetime({ offset: false, precision: 0 });
const agendaDateSchema = z.iso.date();
const agendaLabelSchema = z.string().trim().min(1).max(160);
const agendaRevisionSchema = z.number().int().positive();
const agendaSortOrderSchema = z.number().int().nonnegative().max(10_000);

export const agendaTrackColorSchema = z.enum(["plum", "blue", "gold", "teal", "coral", "slate"]);

export const agendaRoomCreateSchema = z.strictObject({
  name: agendaLabelSchema,
  capacity: z.number().int().positive().max(100_000),
  sortOrder: agendaSortOrderSchema,
});

export const agendaRoomUpdateSchema = agendaRoomCreateSchema.extend({
  revision: agendaRevisionSchema,
});

export const agendaTrackCreateSchema = z.strictObject({
  name: agendaLabelSchema,
  color: agendaTrackColorSchema,
  sortOrder: agendaSortOrderSchema,
});

export const agendaTrackUpdateSchema = z.strictObject({
  color: agendaTrackColorSchema,
  sortOrder: agendaSortOrderSchema,
  revision: agendaRevisionSchema,
});

const agendaDayFields = {
  date: agendaDateSchema,
  label: z.string().trim().min(1).max(120),
  opensAt: agendaTimestampSchema,
  closesAt: agendaTimestampSchema,
  slotMinutes: z.union([
    z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60),
  ]),
};

function validOperatingWindow(value: { opensAt: string; closesAt: string }, context: z.RefinementCtx) {
  const opensAt = Date.parse(value.opensAt);
  const closesAt = Date.parse(value.closesAt);
  if (opensAt >= closesAt) {
    context.addIssue({ code: "custom", path: ["closesAt"], message: "Close time must be after open time" });
  } else if (closesAt - opensAt > 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", path: ["closesAt"], message: "An operating window cannot exceed 24 hours" });
  }
}

export const agendaDayCreateSchema = z.strictObject(agendaDayFields).superRefine(validOperatingWindow);

export const agendaDayUpdateSchema = z.strictObject({
  ...agendaDayFields,
  revision: agendaRevisionSchema,
}).superRefine(validOperatingWindow);

const agendaPlacementFields = {
  dayId: agendaIdSchema,
  roomId: agendaIdSchema,
  startsAt: agendaTimestampSchema,
};

export const agendaPlacementCreateSchema = z.strictObject({
  sessionId: agendaIdSchema,
  ...agendaPlacementFields,
});

export const agendaPlacementUpdateSchema = z.strictObject({
  ...agendaPlacementFields,
  revision: agendaRevisionSchema,
});

export const agendaPlacementDeleteSchema = z.strictObject({
  expectedRevision: agendaRevisionSchema,
});

export const agendaAutoPlaceRequestSchema = z.strictObject({
  sessionIds: z.array(agendaIdSchema).max(500).default([])
    .transform((values) => [...new Set(values)].sort()),
});

export const agendaRoomResponseSchema = z.strictObject({
  id: agendaIdSchema,
  name: agendaLabelSchema,
  capacity: z.number().int().positive().max(100_000),
  sortOrder: agendaSortOrderSchema,
  revision: agendaRevisionSchema,
});

export const agendaTrackResponseSchema = z.strictObject({
  id: agendaIdSchema,
  name: agendaLabelSchema,
  color: agendaTrackColorSchema,
  sortOrder: agendaSortOrderSchema,
  revision: agendaRevisionSchema,
});

export const agendaDayResponseSchema = z.strictObject({
  id: agendaIdSchema,
  dayNumber: z.number().int().positive().max(366),
  ...agendaDayFields,
  revision: agendaRevisionSchema,
}).superRefine(validOperatingWindow);

export const agendaPlacementResponseSchema = z.strictObject({
  id: agendaIdSchema,
  dayId: agendaIdSchema,
  roomId: agendaIdSchema,
  startsAt: agendaTimestampSchema,
  endsAt: agendaTimestampSchema,
  revision: agendaRevisionSchema,
}).refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), {
  path: ["endsAt"],
  error: "Placement end time must be after its start time",
});

export const agendaPresenterResponseSchema = z.strictObject({
  id: agendaIdSchema,
  slug: agendaSlugSchema,
  name: z.string().trim().min(1).max(120),
  role: z.enum(["primary", "co_presenter"]),
});

export const agendaSessionResponseSchema = z.strictObject({
  id: agendaIdSchema,
  slug: agendaSlugSchema,
  title: z.string().trim().min(1).max(20_000),
  track: agendaLabelSchema,
  format: sessionFormatSchema,
  durationMinutes: z.number().int().positive().max(480),
  acceptanceStatus: z.literal("accepted"),
  approvalStatus: z.enum(["pending", "changes_requested", "approved"]),
  publicationStatus: z.enum(["private", "ready", "published"]),
  revision: agendaRevisionSchema,
  presenters: z.array(agendaPresenterResponseSchema).min(1).max(20),
  placement: agendaPlacementResponseSchema.nullable(),
}).superRefine((value, context) => {
  if (value.presenters.filter((presenter) => presenter.role === "primary").length !== 1) {
    context.addIssue({ code: "custom", path: ["presenters"], message: "A scheduled session requires exactly one primary presenter" });
  }
  if (value.placement && Date.parse(value.placement.endsAt) - Date.parse(value.placement.startsAt) !== value.durationMinutes * 60_000) {
    context.addIssue({ code: "custom", path: ["placement", "endsAt"], message: "Placement duration must match the session duration" });
  }
});

export const agendaConflictResponseSchema = z.strictObject({
  kind: z.literal("speaker_overlap"),
  speaker: z.strictObject({
    id: agendaIdSchema,
    name: z.string().trim().min(1).max(120),
  }),
  sessionIds: z.tuple([agendaIdSchema, agendaIdSchema]).refine(
    ([left, right]) => left !== right,
    "A conflict must reference two distinct sessions",
  ),
  startsAt: agendaTimestampSchema,
  endsAt: agendaTimestampSchema,
}).refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), {
  path: ["endsAt"],
  error: "Conflict end time must be after its start time",
});

const agendaEventResponseSchema = z.strictObject({
  slug: agendaSlugSchema,
  name: z.string().trim().min(1).max(200),
  timeZone: z.string().trim().min(1).max(64).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Use a valid IANA time zone"),
  status: z.enum(["draft", "open", "scheduled", "published"]),
  agendaPublishedAt: agendaTimestampSchema.nullable(),
});

const agendaPublicationSummarySchema = z.strictObject({
  publicSessionCount: z.number().int().nonnegative().max(5_000),
  unplacedCount: z.number().int().nonnegative().max(5_000),
  contentNotApprovedCount: z.number().int().nonnegative().max(5_000),
  primarySpeakerNotPublicCount: z.number().int().nonnegative().max(5_000),
  readinessBlockedCount: z.number().int().nonnegative().max(5_000),
  awaitingPublicationCount: z.number().int().nonnegative().max(5_000),
});

export const agendaResponseSchema = z.strictObject({
  event: agendaEventResponseSchema,
  publication: agendaPublicationSummarySchema,
  days: z.array(agendaDayResponseSchema).max(366),
  rooms: z.array(agendaRoomResponseSchema).max(500),
  tracks: z.array(agendaTrackResponseSchema).max(500),
  sessions: z.array(agendaSessionResponseSchema).max(5_000),
  conflicts: z.array(agendaConflictResponseSchema).max(10_000),
}).superRefine((value, context) => {
  const dayById = new Map(value.days.map((day) => [day.id, day]));
  const roomIds = new Set(value.rooms.map((room) => room.id));
  const sessionById = new Map(value.sessions.map((session) => [session.id, session]));
  for (const collection of [value.days, value.rooms, value.tracks, value.sessions]) {
    if (new Set(collection.map((item) => item.id)).size !== collection.length) {
      context.addIssue({ code: "custom", message: "Agenda identities must be unique" });
    }
  }
  const accountedSessions = Object.values(value.publication)
    .reduce((total, count) => total + count, 0);
  if (accountedSessions !== value.sessions.length) {
    context.addIssue({
      code: "custom",
      path: ["publication"],
      message: "Publication summary must account for every accepted session",
    });
  }
  const derivedUnplacedCount = value.sessions.filter((session) => session.placement === null).length;
  if (value.publication.unplacedCount !== derivedUnplacedCount) {
    context.addIssue({
      code: "custom",
      path: ["publication", "unplacedCount"],
      message: "Unplaced count must match sessions without a placement",
    });
  }
  for (const [index, session] of value.sessions.entries()) {
    const placement = session.placement;
    if (!placement) continue;
    const day = dayById.get(placement.dayId);
    if (!day || !roomIds.has(placement.roomId)) {
      context.addIssue({ code: "custom", path: ["sessions", index, "placement"], message: "Placement day and room must belong to the agenda" });
    } else if (Date.parse(placement.startsAt) < Date.parse(day.opensAt) || Date.parse(placement.endsAt) > Date.parse(day.closesAt)) {
      context.addIssue({ code: "custom", path: ["sessions", index, "placement"], message: "Placement must stay within its day operating window" });
    }
  }
  for (const [index, conflict] of value.conflicts.entries()) {
    const sessions = conflict.sessionIds.map((sessionId) => sessionById.get(sessionId));
    if (sessions.some((session) => !session)
      || sessions.some((session) => !session!.presenters.some((presenter) => presenter.id === conflict.speaker.id))) {
      context.addIssue({ code: "custom", path: ["conflicts", index], message: "Conflict sessions must share the named presenter" });
    }
  }
});

const placedResultSchema = z.strictObject({
  sessionId: agendaIdSchema,
  status: z.literal("placed"),
  placement: agendaPlacementResponseSchema,
});

const unplacedResultSchema = z.strictObject({
  sessionId: agendaIdSchema,
  status: z.literal("unplaced"),
  reason: z.enum(["NO_AVAILABLE_SLOT", "SESSION_NOT_ACCEPTED", "SESSION_ALREADY_PLACED"]),
});

export const agendaAutoPlaceResponseSchema = z.strictObject({
  agenda: agendaResponseSchema,
  results: z.array(z.discriminatedUnion("status", [placedResultSchema, unplacedResultSchema])).max(500),
});

const agendaPublicationSkipSchema = z.strictObject({
  reason: z.enum(["UNPLACED", "CONTENT_NOT_APPROVED", "PRIMARY_SPEAKER_NOT_PUBLIC", "READINESS_BLOCKED"]),
  count: z.number().int().positive().max(5_000),
});

export const agendaPublishResponseSchema = z.strictObject({
  agenda: agendaResponseSchema,
  publication: z.strictObject({
    outcome: z.enum(["changed", "unchanged"]),
    newlyPublicSessionCount: z.number().int().nonnegative().max(5_000),
    publicSessionCount: z.number().int().positive().max(5_000),
    skipped: z.array(agendaPublicationSkipSchema).max(4),
  }),
  publicPaths: z.strictObject({
    program: z.literal("/program"),
    calendar: z.string().regex(/^\/api\/program\.ics\?event=[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
}).superRefine((value, context) => {
  if (value.agenda.event.status !== "published" || value.agenda.event.agendaPublishedAt === null) {
    context.addIssue({ code: "custom", path: ["agenda", "event"], message: "A published agenda requires a publication timestamp" });
  }
  if (value.agenda.conflicts.length > 0) {
    context.addIssue({ code: "custom", path: ["agenda", "conflicts"], message: "Resolve speaker conflicts before publishing" });
  }
  const skipReasons = value.publication.skipped.map((item) => item.reason);
  if (new Set(skipReasons).size !== skipReasons.length) {
    context.addIssue({ code: "custom", path: ["publication", "skipped"], message: "Publication skip reasons must be unique" });
  }
  if (value.publication.newlyPublicSessionCount > value.publication.publicSessionCount) {
    context.addIssue({ code: "custom", path: ["publication", "newlyPublicSessionCount"], message: "Newly public sessions cannot exceed the public program" });
  }
  if (value.publication.outcome === "unchanged" && value.publication.newlyPublicSessionCount !== 0) {
    context.addIssue({ code: "custom", path: ["publication", "outcome"], message: "An unchanged publication cannot contain newly public sessions" });
  }
  const accountedSessions = value.publication.publicSessionCount
    + value.publication.skipped.reduce((total, item) => total + item.count, 0);
  if (accountedSessions !== value.agenda.sessions.length) {
    context.addIssue({ code: "custom", path: ["publication"], message: "Publication results must account for every accepted session" });
  }
  const skipCount = (reason: "UNPLACED" | "CONTENT_NOT_APPROVED" | "PRIMARY_SPEAKER_NOT_PUBLIC" | "READINESS_BLOCKED") =>
    value.publication.skipped.find((item) => item.reason === reason)?.count ?? 0;
  const unplacedCount = value.agenda.sessions.filter((session) => session.placement === null).length;
  const contentNotApprovedCount = value.agenda.sessions.filter((session) =>
    session.placement !== null && session.approvalStatus !== "approved").length;
  if (skipCount("UNPLACED") !== unplacedCount) {
    context.addIssue({ code: "custom", path: ["publication", "skipped"], message: "Unplaced skip counts must match the agenda" });
  }
  if (skipCount("CONTENT_NOT_APPROVED") !== contentNotApprovedCount) {
    context.addIssue({ code: "custom", path: ["publication", "skipped"], message: "Approval skip counts must match the agenda" });
  }
});

export type AgendaTrackColor = z.infer<typeof agendaTrackColorSchema>;
export type AgendaRoomCreate = z.infer<typeof agendaRoomCreateSchema>;
export type AgendaRoomUpdate = z.infer<typeof agendaRoomUpdateSchema>;
export type AgendaTrackCreate = z.infer<typeof agendaTrackCreateSchema>;
export type AgendaTrackUpdate = z.infer<typeof agendaTrackUpdateSchema>;
export type AgendaDayCreate = z.infer<typeof agendaDayCreateSchema>;
export type AgendaDayUpdate = z.infer<typeof agendaDayUpdateSchema>;
export type AgendaPlacementCreate = z.infer<typeof agendaPlacementCreateSchema>;
export type AgendaPlacementUpdate = z.infer<typeof agendaPlacementUpdateSchema>;
export type AgendaPlacementDelete = z.infer<typeof agendaPlacementDeleteSchema>;
export type AgendaAutoPlaceRequest = z.infer<typeof agendaAutoPlaceRequestSchema>;
export type AgendaRoomResponse = z.infer<typeof agendaRoomResponseSchema>;
export type AgendaTrackResponse = z.infer<typeof agendaTrackResponseSchema>;
export type AgendaDayResponse = z.infer<typeof agendaDayResponseSchema>;
export type AgendaPlacementResponse = z.infer<typeof agendaPlacementResponseSchema>;
export type AgendaPresenterResponse = z.infer<typeof agendaPresenterResponseSchema>;
export type AgendaSessionResponse = z.infer<typeof agendaSessionResponseSchema>;
export type AgendaConflictResponse = z.infer<typeof agendaConflictResponseSchema>;
export type AgendaResponse = z.infer<typeof agendaResponseSchema>;
export type AgendaAutoPlaceResponse = z.infer<typeof agendaAutoPlaceResponseSchema>;
export type AgendaPublishResponse = z.infer<typeof agendaPublishResponseSchema>;
