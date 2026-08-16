import { describe, expect, it } from "vitest";

import {
  agendaAutoPlaceRequestSchema,
  agendaAutoPlaceResponseSchema,
  agendaDayCreateSchema,
  agendaDayUpdateSchema,
  agendaPlacementCreateSchema,
  agendaPlacementUpdateSchema,
  agendaPublishResponseSchema,
  agendaResponseSchema,
  agendaRoomCreateSchema,
  agendaRoomUpdateSchema,
  agendaTrackCreateSchema,
  agendaTrackUpdateSchema,
} from "./index";

const placement = {
  id: "plc-d-2",
  dayId: "day-d-1",
  roomId: "room-d-2a",
  startsAt: "2027-05-12T17:00:00Z",
  endsAt: "2027-05-12T17:30:00Z",
  revision: 2,
};

const agenda = {
  event: {
    slug: "devflow-conf-2027",
    name: "DevFlow Conf 2027",
    timeZone: "America/Los_Angeles",
    status: "published" as const,
    agendaPublishedAt: "2027-04-20T18:00:00Z",
  },
  publication: {
    publicSessionCount: 2,
    unplacedCount: 0,
    contentNotApprovedCount: 0,
    primarySpeakerNotPublicCount: 0,
    readinessBlockedCount: 0,
    awaitingPublicationCount: 0,
  },
  days: [{
    id: "day-d-1",
    dayNumber: 1,
    date: "2027-05-12",
    label: "Day 1",
    opensAt: "2027-05-12T16:00:00Z",
    closesAt: "2027-05-12T23:00:00Z",
    slotMinutes: 15,
    revision: 1,
  }],
  rooms: [
    { id: "room-d-2a", name: "Room 2A", capacity: 260, sortOrder: 2, revision: 1 },
    { id: "room-d-2b", name: "Room 2B", capacity: 220, sortOrder: 3, revision: 1 },
  ],
  tracks: [
    { id: "track-ai", name: "AI Engineering", color: "plum", sortOrder: 1, revision: 1 },
    { id: "track-platform", name: "Platform & Infra", color: "blue", sortOrder: 2, revision: 1 },
  ],
  sessions: [{
    id: "ses-d-2",
    slug: "taming-40-minute-ci",
    title: "Taming 40-Minute CI",
    track: "Platform & Infra",
    format: "talk" as const,
    durationMinutes: 30,
    acceptanceStatus: "accepted" as const,
    approvalStatus: "approved" as const,
    publicationStatus: "published" as const,
    revision: 3,
    presenters: [
      { id: "spk-d-priya", slug: "priya-raman", name: "Priya Raman", role: "primary" as const },
      { id: "spk-d-marcus", slug: "marcus-okafor", name: "Marcus Okafor", role: "co_presenter" as const },
    ],
    placement,
  }, {
    id: "ses-d-3",
    slug: "your-ai-pair-programmer-is-lying",
    title: "Your AI Pair Programmer Is Lying to You",
    track: "AI Engineering",
    format: "talk" as const,
    durationMinutes: 30,
    acceptanceStatus: "accepted" as const,
    approvalStatus: "approved" as const,
    publicationStatus: "published" as const,
    revision: 2,
    presenters: [{ id: "spk-d-priya", slug: "priya-raman", name: "Priya Raman", role: "primary" as const }],
    placement: { ...placement, id: "plc-d-3", roomId: "room-d-2b" },
  }],
  conflicts: [{
    kind: "speaker_overlap" as const,
    speaker: { id: "spk-d-priya", name: "Priya Raman" },
    sessionIds: ["ses-d-2", "ses-d-3"],
    startsAt: "2027-05-12T17:00:00Z",
    endsAt: "2027-05-12T17:30:00Z",
  }],
};

describe("agenda contracts", () => {
  it("accepts a connected event-scoped agenda and rejects malformed continuity", () => {
    expect(agendaResponseSchema.parse(agenda)).toEqual(agenda);
    expect(agendaResponseSchema.safeParse({
      ...agenda,
      sessions: [{ ...agenda.sessions[0], placement: { ...placement, endsAt: "2027-05-12T16:59:00Z" } }],
    }).success).toBe(false);
    expect(agendaResponseSchema.safeParse({
      ...agenda,
      sessions: [{ ...agenda.sessions[0], presenters: [] }],
    }).success).toBe(false);
    expect(agendaResponseSchema.safeParse({
      ...agenda,
      sessions: [{ ...agenda.sessions[0], placement: { ...placement, dayId: "missing-day" } }],
    }).success).toBe(false);
    expect(agendaResponseSchema.safeParse({
      ...agenda,
      sessions: [{ ...agenda.sessions[0], placement: { ...placement, startsAt: "2027-05-12T15:30:00Z", endsAt: "2027-05-12T16:00:00Z" } }],
    }).success).toBe(false);
    expect(agendaResponseSchema.safeParse({
      ...agenda,
      conflicts: [{ ...agenda.conflicts[0], speaker: { id: "spk-not-shared", name: "Not Shared" } }],
    }).success).toBe(false);
    expect(agendaResponseSchema.safeParse({
      ...agenda,
      publication: { ...agenda.publication, publicSessionCount: 1 },
    }).success).toBe(false);
    expect(agendaResponseSchema.safeParse({
      ...agenda,
      publication: { ...agenda.publication, publicSessionCount: 1, unplacedCount: 1 },
    }).success).toBe(false);
    expect(agendaResponseSchema.safeParse({ ...agenda, privateEmail: "speaker@example.com" }).success).toBe(false);
  });

  it("normalizes strict room and track mutations and requires revisions on updates", () => {
    expect(agendaRoomCreateSchema.parse({ name: " Room 3 ", capacity: 120, sortOrder: 4 }))
      .toEqual({ name: "Room 3", capacity: 120, sortOrder: 4 });
    expect(agendaRoomUpdateSchema.safeParse({ name: "Room 3", capacity: 120, sortOrder: 4 }).success).toBe(false);
    expect(agendaRoomUpdateSchema.safeParse({ name: "Room 3", capacity: 120, sortOrder: 4, revision: 1 }).success).toBe(true);
    expect(agendaTrackCreateSchema.parse({ name: " AI Engineering ", color: "plum", sortOrder: 1 }))
      .toEqual({ name: "AI Engineering", color: "plum", sortOrder: 1 });
    expect(agendaTrackCreateSchema.safeParse({ name: "AI", color: "#ff00ff", sortOrder: 1 }).success).toBe(false);
    expect(agendaTrackUpdateSchema.safeParse({ color: "gold", sortOrder: 2, revision: 1 }).success).toBe(true);
    expect(agendaTrackUpdateSchema.safeParse({ name: "Renamed", color: "gold", sortOrder: 2, revision: 1 }).success).toBe(false);
  });

  it("validates operating windows, canonical UTC starts, and server-derived placement ends", () => {
    const day = {
      date: "2027-05-12",
      label: "Day 1",
      opensAt: "2027-05-12T16:00:00Z",
      closesAt: "2027-05-12T23:00:00Z",
      slotMinutes: 15,
    };
    expect(agendaDayCreateSchema.safeParse(day).success).toBe(true);
    expect(agendaDayCreateSchema.safeParse({ ...day, closesAt: day.opensAt }).success).toBe(false);
    expect(agendaDayUpdateSchema.safeParse({ ...day, revision: 1 }).success).toBe(true);
    expect(agendaDayUpdateSchema.safeParse({ ...day, slotMinutes: 7, revision: 1 }).success).toBe(false);

    expect(agendaPlacementCreateSchema.parse({
      sessionId: "ses-d-2", dayId: "day-d-1", roomId: "room-d-2a", startsAt: "2027-05-12T17:00:00Z",
    })).not.toHaveProperty("endsAt");
    expect(agendaPlacementCreateSchema.safeParse({
      sessionId: "ses-d-2", dayId: "day-d-1", roomId: "room-d-2a",
      startsAt: "2027-05-12T17:00:00.000Z", endsAt: "2027-05-12T17:30:00Z",
    }).success).toBe(false);
    expect(agendaPlacementUpdateSchema.safeParse({
      dayId: "day-d-1", roomId: "room-d-2a", startsAt: "2027-05-12T17:15:00Z", revision: 2,
    }).success).toBe(true);
  });

  it("represents deterministic auto-place outcomes and publication handoff paths", () => {
    expect(agendaAutoPlaceRequestSchema.parse({ sessionIds: ["ses-d-3", "ses-d-2", "ses-d-2"] }))
      .toEqual({ sessionIds: ["ses-d-2", "ses-d-3"] });
    expect(agendaAutoPlaceResponseSchema.safeParse({
      agenda,
      results: [
        { sessionId: "ses-d-2", status: "placed", placement },
        { sessionId: "ses-d-3", status: "unplaced", reason: "NO_AVAILABLE_SLOT" },
      ],
    }).success).toBe(true);
    expect(agendaAutoPlaceResponseSchema.safeParse({
      agenda,
      results: [{ sessionId: "ses-d-2", status: "placed", reason: "NO_AVAILABLE_SLOT" }],
    }).success).toBe(false);
    expect(agendaPublishResponseSchema.safeParse({
      agenda: { ...agenda, conflicts: [] },
      publication: {
        outcome: "unchanged",
        newlyPublicSessionCount: 0,
        publicSessionCount: 2,
        skipped: [],
      },
      publicPaths: {
        program: "/program",
        calendar: "/api/program.ics?event=devflow-conf-2027",
      },
    }).success).toBe(true);
    expect(agendaPublishResponseSchema.safeParse({
      agenda: { ...agenda, conflicts: [] },
      publication: {
        outcome: "unchanged",
        newlyPublicSessionCount: 0,
        publicSessionCount: 1,
        skipped: [{ reason: "READINESS_BLOCKED", count: 1 }],
      },
      publicPaths: {
        program: "/program",
        calendar: "/api/program.ics?event=devflow-conf-2027",
      },
    }).success).toBe(true);
    expect(agendaPublishResponseSchema.safeParse({
      agenda: { ...agenda, conflicts: [] },
      publication: {
        outcome: "changed",
        newlyPublicSessionCount: 1,
        publicSessionCount: 1,
        skipped: [],
      },
      publicPaths: {
        program: "/program",
        calendar: "/api/program.ics?event=devflow-conf-2027",
      },
    }).success).toBe(false);
    expect(agendaPublishResponseSchema.safeParse({
      agenda: { ...agenda, conflicts: [] },
      publication: {
        outcome: "unchanged",
        newlyPublicSessionCount: 1,
        publicSessionCount: 2,
        skipped: [],
      },
      publicPaths: {
        program: "/program",
        calendar: "/api/program.ics?event=devflow-conf-2027",
      },
    }).success).toBe(false);
    expect(agendaPublishResponseSchema.safeParse({
      agenda: { ...agenda, conflicts: [] },
      publication: {
        outcome: "unchanged",
        newlyPublicSessionCount: 0,
        publicSessionCount: 1,
        skipped: [{ reason: "UNPLACED", count: 1 }],
      },
      publicPaths: {
        program: "/program",
        calendar: "/api/program.ics?event=devflow-conf-2027",
      },
    }).success).toBe(false);
  });
});
