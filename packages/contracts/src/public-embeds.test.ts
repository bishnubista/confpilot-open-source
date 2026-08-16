import { describe, expect, it } from "vitest";

import {
  defaultEmbedAppearance,
  embedConfigCreateSchema,
  embedConfigResponseSchema,
  embedConfigUpdateSchema,
  personalCalendarRequestSchema,
  publicEmbedResponseSchema,
  publicProgramResponseSchema,
} from "./index";

const publishedProgram = {
  event: {
    slug: "devflow-conf-2027",
    name: "DevFlow Conf 2027",
    tagline: "The developer workflow conference",
    location: "San Francisco, CA",
    description: "A practical conference.",
    startsOn: "2027-05-12",
    endsOn: "2027-05-14",
    timeZone: "America/Los_Angeles",
    status: "published" as const,
  },
  sessions: [{
    slug: "evidence-first-program-reviews",
    title: "Evidence-First Program Reviews",
    abstract: "A practical program review workflow.",
    track: "Developer Experience",
    format: "talk" as const,
    durationMinutes: 30,
    publicationStatus: "published" as const,
    schedule: {
      dayNumber: 1,
      date: "2027-05-12",
      label: "Day 1",
      room: "Main Stage",
      startsAt: "2027-05-12T17:00:00Z",
      endsAt: "2027-05-12T17:30:00Z",
    },
    speakers: [{
      slug: "proposal-owner",
      name: "Proposal Owner",
      title: "Staff Engineer",
      company: "Example",
      headshotUrl: null,
      headshotFallback: "PO",
    }],
  }],
  speakers: [{
    slug: "proposal-owner",
    name: "Proposal Owner",
    title: "Staff Engineer",
    company: "Example",
    bio: "Builds evidence-first program systems.",
    headshotUrl: null,
    headshotFallback: "PO",
    publicVisibility: "published" as const,
    sessions: [{
      slug: "evidence-first-program-reviews",
      title: "Evidence-First Program Reviews",
      track: "Developer Experience",
      format: "talk" as const,
    }],
  }],
};

const filters = {
  days: ["2027-05-13", "2027-05-12", "2027-05-12"],
  tracks: [" Platform & Infra ", "AI Engineering", "AI Engineering"],
  formats: ["workshop" as const, "talk" as const, "talk" as const],
  rooms: ["Workshop Lab", " Main Stage ", "Main Stage"],
};

describe("public program and embed contracts", () => {
  it("bounds strict personal-calendar requests without putting selections in URLs", () => {
    const sessionSlugs = Array.from({ length: 100 }, (_, index) => `session-${index + 1}`);
    expect(personalCalendarRequestSchema.parse({
      event: "devflow-conf-2027",
      sessionSlugs,
    })).toEqual({ event: "devflow-conf-2027", sessionSlugs });
    expect(personalCalendarRequestSchema.safeParse({
      event: "devflow-conf-2027",
      sessionSlugs: [...sessionSlugs, "session-101"],
    }).success).toBe(false);
    expect(personalCalendarRequestSchema.safeParse({
      event: "devflow-conf-2027",
      sessionSlugs: [],
    }).success).toBe(false);
    expect(personalCalendarRequestSchema.safeParse({
      event: "devflow-conf-2027",
      sessionSlugs: ["session-1"],
      privateNote: "unsupported",
    }).success).toBe(false);
  });

  it("accepts only explicitly public program projections", () => {
    expect(publicProgramResponseSchema.safeParse(publishedProgram).success).toBe(true);
    expect(publicProgramResponseSchema.safeParse({
      ...publishedProgram,
      event: { ...publishedProgram.event, status: "scheduled" },
    }).success).toBe(false);
    expect(publicProgramResponseSchema.safeParse({
      ...publishedProgram,
      sessions: [{
        ...publishedProgram.sessions[0],
        speakers: [{ ...publishedProgram.sessions[0].speakers[0], headshotUrl: "https://cdn.example.com/speaker.webp" }],
      }],
    }).success).toBe(true);
    for (const headshotUrl of ["javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://example.com/speaker.webp"]) {
      expect(publicProgramResponseSchema.safeParse({
        ...publishedProgram,
        sessions: [{
          ...publishedProgram.sessions[0],
          speakers: [{ ...publishedProgram.sessions[0].speakers[0], headshotUrl }],
        }],
      }).success).toBe(false);
    }
    expect(publicProgramResponseSchema.safeParse({
      ...publishedProgram,
      sessions: [{ ...publishedProgram.sessions[0], publicationStatus: "private" }],
    }).success).toBe(false);
    expect(publicProgramResponseSchema.safeParse({
      ...publishedProgram,
      sessions: [{ ...publishedProgram.sessions[0], schedule: null }],
    }).success).toBe(false);
    expect(publicProgramResponseSchema.safeParse({
      ...publishedProgram,
      speakers: [{ ...publishedProgram.speakers[0], email: "private@example.com" }],
    }).success).toBe(false);
    expect(publicProgramResponseSchema.safeParse({
      ...publishedProgram,
      speakers: [{ ...publishedProgram.speakers[0], publicVisibility: "private" }],
    }).success).toBe(false);
    expect(publicProgramResponseSchema.safeParse({
      ...publishedProgram,
      sessions: [{
        ...publishedProgram.sessions[0],
        schedule: { ...publishedProgram.sessions[0].schedule!, endsAt: "2027-05-12T16:59:00Z" },
      }],
    }).success).toBe(false);
  });

  it("normalizes strict create filters and rejects unsupported fields and views", () => {
    expect(embedConfigCreateSchema.parse({
      slug: "homepage-agenda",
      name: " Homepage agenda ",
      view: "agenda",
      filters,
      enabled: true,
    })).toEqual({
      slug: "homepage-agenda",
      name: "Homepage agenda",
      view: "agenda",
      filters: {
        days: ["2027-05-12", "2027-05-13"],
        tracks: ["AI Engineering", "Platform & Infra"],
        formats: ["talk", "workshop"],
        rooms: ["Main Stage", "Workshop Lab"],
      },
      outputFormat: "iframe",
      appearance: defaultEmbedAppearance,
      enabled: true,
    });

    expect(embedConfigCreateSchema.parse({
      slug: "unicode-tracks",
      name: "Unicode tracks",
      view: "sessions",
      filters: { days: [], tracks: ["😀 AI", "Ａ Platform"], formats: [], rooms: [] },
      enabled: false,
    }).filters.tracks).toEqual(["Ａ Platform", "😀 AI"]);
    expect(embedConfigCreateSchema.safeParse({
      slug: "homepage-agenda",
      name: "Homepage agenda",
      view: "calendar",
      filters: { days: [], tracks: [], formats: [], rooms: [] },
      enabled: true,
    }).success).toBe(false);
    expect(embedConfigCreateSchema.safeParse({
      slug: "Homepage Agenda",
      name: "Homepage agenda",
      view: "agenda",
      filters: { days: [], tracks: [], formats: [], rooms: [] },
      enabled: true,
    }).success).toBe(false);
    expect(embedConfigCreateSchema.safeParse({
      slug: "homepage-agenda",
      name: "Homepage agenda",
      view: "agenda",
      filters: { days: [], tracks: [], formats: [], rooms: [], speakers: [] },
      enabled: true,
    }).success).toBe(false);
    expect(embedConfigCreateSchema.safeParse({
      slug: "homepage-agenda",
      name: "Homepage agenda",
      view: "agenda",
      filters: { days: ["2027-02-30"], tracks: [], formats: [], rooms: [] },
      enabled: true,
    }).success).toBe(false);
  });

  it("keeps the stable slug out of revision-guarded updates", () => {
    const update = {
      name: "Homepage agenda",
      view: "agenda" as const,
      filters: { days: [], tracks: [], formats: [], rooms: [] },
      outputFormat: "json" as const,
      appearance: { ...defaultEmbedAppearance, theme: "dark" as const, accentColor: "#AABBCC" },
      enabled: false,
      revision: 3,
    };
    expect(embedConfigUpdateSchema.safeParse(update).success).toBe(true);
    expect(embedConfigUpdateSchema.safeParse({ ...update, slug: "renamed" }).success).toBe(false);
    expect(embedConfigUpdateSchema.safeParse({ ...update, revision: 0 }).success).toBe(false);
  });

  it("separates organizer metadata from the enabled public response", () => {
    const config = {
      id: "embed-1",
      eventSlug: "devflow-conf-2027",
      slug: "homepage-agenda",
      name: "Homepage agenda",
      view: "agenda" as const,
      filters: { days: [], tracks: [], formats: [], rooms: [] },
      outputFormat: "json" as const,
      appearance: { ...defaultEmbedAppearance, theme: "dark" as const, accentColor: "#AABBCC" },
      enabled: true,
      revision: 1,
      createdAt: "2027-02-20T18:00:00Z",
      updatedAt: "2027-02-20T18:00:00Z",
      publicPath: "/embed/devflow-conf-2027/homepage-agenda",
      jsonPath: "/api/public/events/devflow-conf-2027/embeds/homepage-agenda",
      calendarPath: "/api/public/events/devflow-conf-2027/embeds/homepage-agenda/calendar.ics",
    };
    expect(embedConfigResponseSchema.safeParse(config).success).toBe(true);
    expect(publicEmbedResponseSchema.safeParse({
      embed: {
        slug: config.slug,
        name: config.name,
        view: config.view,
        filters: config.filters,
        appearance: config.appearance,
        revision: config.revision,
      },
      program: publishedProgram,
    }).success).toBe(true);
    expect(publicEmbedResponseSchema.safeParse({ embed: config, program: publishedProgram }).success)
      .toBe(false);
    expect(publicEmbedResponseSchema.safeParse({
      embed: {
        slug: config.slug,
        name: config.name,
        view: config.view,
        filters: config.filters,
        outputFormat: config.outputFormat,
        appearance: config.appearance,
        revision: config.revision,
      },
      program: publishedProgram,
    }).success).toBe(false);
  });

  it("normalizes accent colors and rejects unsupported presentation settings", () => {
    expect(embedConfigCreateSchema.parse({
      slug: "branded-program",
      name: "Branded program",
      view: "sessions",
      filters: { days: [], tracks: [], formats: [], rooms: [] },
      outputFormat: "json",
      appearance: { ...defaultEmbedAppearance, accentColor: "#a1b2c3" },
      enabled: false,
    }).appearance.accentColor).toBe("#A1B2C3");
    for (const appearance of [
      { ...defaultEmbedAppearance, accentColor: "red" },
      { ...defaultEmbedAppearance, theme: "system" },
      { ...defaultEmbedAppearance, showSearch: "yes" },
    ]) expect(embedConfigCreateSchema.safeParse({
      slug: "branded-program",
      name: "Branded program",
      view: "sessions",
      filters: { days: [], tracks: [], formats: [], rooms: [] },
      outputFormat: "iframe",
      appearance,
      enabled: false,
    }).success).toBe(false);
  });
});
