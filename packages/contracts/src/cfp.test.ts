import { describe, expect, it } from "vitest";

import {
  cfpConfigUpdateSchema,
  cfpPublicConfigResponseSchema,
  proposalCoPresenterListResponseSchema,
  proposalCoPresenterWriteSchema,
  speakerRegistrationSchema,
} from "./index";

describe("public CFP abuse-prevention contracts", () => {
  it("requires a bounded Turnstile token for public account creation", () => {
    const input = {
      displayName: "Avery Quinn",
      email: "avery@example.com",
      password: "test-only-password-123",
      title: "",
      company: "",
      bio: "",
    };

    expect(speakerRegistrationSchema.safeParse(input).success).toBe(false);
    expect(speakerRegistrationSchema.safeParse({ ...input, turnstileToken: "token" }).success).toBe(true);
    expect(speakerRegistrationSchema.safeParse({ ...input, turnstileToken: "x".repeat(2_049) }).success).toBe(false);
  });

  it("exposes only an enabled public site key or an explicit disabled state", () => {
    const base = {
      event: { slug: "example-conf", name: "Example Conf", tagline: "Example event", location: "Online", description: "A public example event.", startsOn: "2027-01-01", endsOn: "2027-01-02" },
      status: "published",
      state: "open",
      opensAt: "2026-01-01T00:00:00Z",
      closesAt: "2026-12-01T00:00:00Z",
      confirmationMessage: "Thank you.",
      revision: 1,
      fields: [],
    };

    expect(cfpPublicConfigResponseSchema.safeParse({ ...base, turnstile: { enabled: true, siteKey: "public-site-key" } }).success).toBe(true);
    expect(cfpPublicConfigResponseSchema.safeParse({ ...base, turnstile: { enabled: false, siteKey: null } }).success).toBe(true);
    expect(cfpPublicConfigResponseSchema.safeParse({ ...base, turnstile: { enabled: false, siteKey: "leaked-value" } }).success).toBe(false);
    expect(cfpPublicConfigResponseSchema.safeParse({
      ...base,
      event: { ...base.event, startsOn: "2027-01-03", endsOn: "2027-01-02" },
      turnstile: { enabled: false, siteKey: null },
    }).success).toBe(false);
  });
});

describe("organizer CFP customization contracts", () => {
  const event = {
    name: "Example Conf",
    tagline: "A configurable event",
    location: "Oakland, CA",
    description: "A complete event description.",
    startsOn: "2027-06-01",
    endsOn: "2027-06-02",
  };
  const fields = [
    { key: "title", section: "session", type: "short_text", label: "Title", helpText: "", required: true, options: [], sortOrder: 10, showWhen: null },
    { key: "abstract", section: "session", type: "long_text", label: "Abstract", helpText: "", required: true, options: [], sortOrder: 20, showWhen: null },
    { key: "track", section: "session", type: "dropdown", label: "Track", helpText: "", required: true, options: [{ value: "Main", label: "Main" }], sortOrder: 30, showWhen: null },
    { key: "format", section: "session", type: "dropdown", label: "Format", helpText: "", required: true, options: [{ value: "talk", label: "Talk", durationMinutes: 30 }], sortOrder: 40, showWhen: null },
  ];
  const input = {
    expectedRevision: 3,
    event,
    status: "published",
    opensAt: "2026-08-01T00:00:00Z",
    closesAt: "2027-05-01T00:00:00Z",
    confirmationMessage: "Thank you.",
    fields,
  };

  it("requires a revision guard and bounded chronological event copy", () => {
    expect(cfpConfigUpdateSchema.safeParse(input).success).toBe(true);
    expect(cfpConfigUpdateSchema.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false);
    expect(cfpConfigUpdateSchema.safeParse({ ...input, event: { ...event, startsOn: "2027-06-03" } }).success).toBe(false);
    expect(cfpConfigUpdateSchema.safeParse({ ...input, event: { ...event, privateNotes: "no" } }).success).toBe(false);
  });

  it("keeps canonical fields and format durations safe", () => {
    expect(cfpConfigUpdateSchema.safeParse({ ...input, fields: fields.filter(({ key }) => key !== "track") }).success).toBe(false);
    expect(cfpConfigUpdateSchema.safeParse({
      ...input,
      fields: fields.map((field) => field.key === "title" ? { ...field, showWhen: { fieldKey: "track", equals: "Main" } } : field),
    }).success).toBe(false);
    const unsafeFormat = fields.map((field) => field.key === "format"
      ? { ...field, options: [{ ...field.options[0], durationMinutes: 45 }] }
      : field);
    expect(cfpConfigUpdateSchema.safeParse({ ...input, fields: unsafeFormat }).success).toBe(false);
    expect(cfpConfigUpdateSchema.safeParse({
      ...input,
      fields: [...fields, { key: "details", section: "session", type: "long_text", label: "Details", helpText: "", required: false, options: [], sortOrder: 50, showWhen: { fieldKey: "track", equals: "Missing" } }],
    }).success).toBe(false);
  });
});

describe("proposal participant contracts", () => {
  it("normalizes bounded co-presenter input without accepting extra identity fields", () => {
    expect(proposalCoPresenterWriteSchema.parse({
      name: "  Morgan Lee  ",
      email: "  MORGAN.LEE@EXAMPLE.COM  ",
    })).toEqual({ name: "Morgan Lee", email: "morgan.lee@example.com" });
    expect(proposalCoPresenterWriteSchema.safeParse({
      name: "Morgan Lee",
      email: "morgan@example.com",
      userId: "not-an-authorized-link",
    }).success).toBe(false);
  });

  it("keeps participant responses role-labelled and strict", () => {
    const participant = {
      id: "presenter-1",
      name: "Morgan Lee",
      email: "morgan@example.com",
      role: "co_presenter",
    };
    expect(proposalCoPresenterListResponseSchema.safeParse({ participants: [participant] }).success).toBe(true);
    expect(proposalCoPresenterListResponseSchema.safeParse({
      participants: [{ ...participant, role: "moderator" }],
    }).success).toBe(false);
    expect(proposalCoPresenterListResponseSchema.safeParse({
      participants: [{ ...participant, privateNotes: "must not cross the contract" }],
    }).success).toBe(false);
  });
});
