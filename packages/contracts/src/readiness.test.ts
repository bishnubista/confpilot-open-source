import { describe, expect, it } from "vitest";

import { programReadinessResponseSchema } from "./readiness";

const validResponse = {
  event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
  summary: { accepted: 1, publishReady: 0, blocked: 1, percent: 0 },
  lifecycle: [
    { stage: "accepted", label: "Accepted", count: 1, total: 1 },
    { stage: "profile_ready", label: "Profile ready", count: 1, total: 1 },
    { stage: "deliverables_ready", label: "Deliverables ready", count: 1, total: 1 },
    { stage: "scheduled", label: "Scheduled", count: 0, total: 1 },
    { stage: "approved", label: "Approved", count: 1, total: 1 },
    { stage: "published", label: "Published", count: 0, total: 1 },
  ],
  blockers: [{
    id: "session_unscheduled:session-1",
    kind: "session_unscheduled",
    entityType: "session",
    entityId: "session-1",
    entityLabel: "Evidence-first agents",
    rule: "Accepted sessions need an agenda placement",
    explanation: "This accepted session has no agenda placement.",
    actionLabel: "Place session",
    actionPath: "/admin/agenda?session=session-1",
  }],
} as const;

describe("program readiness contract", () => {
  it("accepts the stable readiness projection", () => {
    expect(programReadinessResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it("rejects unknown fields and non-organizer action paths", () => {
    expect(programReadinessResponseSchema.safeParse({ ...validResponse, privateEmail: "hidden@example.com" }).success).toBe(false);
    expect(programReadinessResponseSchema.safeParse({
      ...validResponse,
      blockers: [{ ...validResponse.blockers[0], actionPath: "/program" }],
    }).success).toBe(false);
  });

  it("rejects mismatched denominators, derived summaries, and stage order", () => {
    expect(programReadinessResponseSchema.safeParse({
      ...validResponse,
      summary: { ...validResponse.summary, blocked: 0 },
    }).success).toBe(false);
    expect(programReadinessResponseSchema.safeParse({
      ...validResponse,
      lifecycle: validResponse.lifecycle.map((stage, index) => ({ ...stage, total: index === 2 ? 2 : stage.total })),
    }).success).toBe(false);
    expect(programReadinessResponseSchema.safeParse({
      ...validResponse,
      lifecycle: [validResponse.lifecycle[1], validResponse.lifecycle[0], ...validResponse.lifecycle.slice(2)],
    }).success).toBe(false);
  });
});
