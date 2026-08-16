import { describe, expect, it } from "vitest";

import {
  organizerEventCreateResponseSchema,
  organizerEventCreateSchema,
} from "./index";

const event = {
  slug: "community-conf-2027",
  name: "Community Conf 2027",
  tagline: "A practical gathering",
  location: "Oakland, CA",
  description: "A conference run by and for the local community.",
  startsOn: "2027-09-08",
  endsOn: "2027-09-10",
  timeZone: "America/Los_Angeles",
  cfpOpensAt: "2027-01-15T18:00:00Z",
  cfpClosesAt: "2027-05-15T23:59:00Z",
  initialTrack: "Programming",
};

describe("organizer event management contracts", () => {
  it("accepts a bounded draft-event setup", () => {
    expect(organizerEventCreateSchema.parse(event)).toEqual(event);
  });

  it("rejects invalid dates, slugs, time zones, and CFP windows", () => {
    expect(organizerEventCreateSchema.safeParse({ ...event, slug: "Community Conf" }).success).toBe(false);
    expect(organizerEventCreateSchema.safeParse({ ...event, endsOn: "2027-09-07" }).success).toBe(false);
    expect(organizerEventCreateSchema.safeParse({ ...event, timeZone: "local" }).success).toBe(false);
    expect(organizerEventCreateSchema.safeParse({ ...event, cfpClosesAt: event.cfpOpensAt }).success).toBe(false);
  });

  it("keeps the returned membership session explicit", () => {
    expect(organizerEventCreateResponseSchema.safeParse({
      event: { slug: event.slug, name: event.name, status: "draft" },
      session: {
        user: { id: "organizer-1", email: "organizer@example.test", displayName: "Organizer" },
        memberships: [
          { eventSlug: "existing-conf", role: "organizer" },
          { eventSlug: event.slug, role: "organizer" },
        ],
      },
    }).success).toBe(true);
  });
});
