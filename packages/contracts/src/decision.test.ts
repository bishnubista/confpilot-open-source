import { describe, expect, it } from "vitest";

import {
  decisionListResponseSchema,
  decisionRecordRequestSchema,
  notificationPreviewResponseSchema,
  notificationQueueRequestSchema,
  notificationStateSchema,
  ownerWorkspaceResponseSchema,
  proposalResponseSchema,
} from "./index";

const proposal = {
  id: "proposal-1",
  publicId: "ABS-301",
  slug: "evidence-first-program-reviews",
  title: "Evidence-First Program Reviews",
};

const actor = { userId: "organizer-1", displayName: "Program Organizer" };
const decidedAt = "2027-04-20T17:00:00Z";

describe("decision and notification contracts", () => {
  it("accepts only a terminal decision with a normalized rationale", () => {
    expect(decisionRecordRequestSchema.parse({
      proposalId: proposal.id,
      decision: "waitlist",
      rationale: "  Strong proposal; no remaining program capacity.  ",
    })).toEqual({
      proposalId: proposal.id,
      decision: "waitlist",
      rationale: "Strong proposal; no remaining program capacity.",
    });

    for (const invalid of [
      { proposalId: proposal.id, decision: "discuss", rationale: "Review again." },
      { proposalId: proposal.id, decision: "accept", rationale: "   " },
      { proposalId: proposal.id, decision: "accept", rationale: "Ready.", idempotencyKey: "client-key" },
      { proposalId: proposal.id, decision: "reject", rationale: "Outside scope.", previewToken: "token" },
    ]) {
      expect(decisionRecordRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps handoff and notification state explicit", () => {
    const accepted = {
      proposal,
      decision: {
        id: "decision-1",
        value: "accept" as const,
        rationale: "Strong evidence.",
        decidedBy: actor,
        decidedAt,
      },
      handoff: {
        status: "materialized" as const,
        acceptanceId: "acceptance-1",
        acceptedAt: decidedAt,
        programSession: { id: "session-1", slug: proposal.slug },
      },
      notification: { status: "not_queued" as const },
    };
    const waitlisted = {
      ...accepted,
      decision: { ...accepted.decision, value: "waitlist" as const },
      handoff: { status: "not_applicable" as const },
    };

    expect(decisionListResponseSchema.safeParse({
      event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
      decisions: [accepted, waitlisted],
    }).success).toBe(true);
    expect(decisionListResponseSchema.safeParse({
      event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
      decisions: [{ ...waitlisted, handoff: accepted.handoff }],
    }).success).toBe(false);
    expect(decisionListResponseSchema.safeParse({
      event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
      decisions: [{ ...accepted, handoff: { status: "not_applicable" } }],
    }).success).toBe(false);
    expect(notificationStateSchema.safeParse({
      status: "provider_accepted",
      id: "notification-1",
      recipient: {
        speakerId: "speaker-1",
        userId: null,
        name: "Unlinked Speaker",
        email: null,
      },
      subject: "Program decision",
      body: "Your proposal has a decision.",
      queuedAt: decidedAt,
      providerAcceptedAt: "2027-04-20T17:01:00Z",
    }).success).toBe(true);
    expect(notificationStateSchema.safeParse({
      status: "queued",
      id: "notification-1",
      recipient: { speakerId: "speaker-1", userId: null, name: "Unlinked Speaker", email: null },
      subject: "Program decision",
      body: "Your proposal has a decision.",
      queuedAt: decidedAt,
      providerAcceptedAt: "2027-04-20T17:01:00Z",
    }).success).toBe(false);
  });

  it("derives notification recipients server-side and accepts only editable content", () => {
    const preview = {
      proposal,
      decision: { id: "decision-1", value: "reject" as const },
      recipient: {
        speakerId: "speaker-1",
        userId: "speaker-user-1",
        name: "Proposal Owner",
        email: "owner@example.com",
      },
      subject: "A decision on your proposal",
      body: "Thank you for submitting.",
    };

    expect(notificationPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(notificationPreviewResponseSchema.safeParse({ ...preview, previewToken: "token" }).success).toBe(false);
    expect(notificationQueueRequestSchema.parse({
      subject: "  A decision on your proposal  ",
      body: "  Thank you for submitting.  ",
    })).toEqual({
      subject: "A decision on your proposal",
      body: "Thank you for submitting.",
    });
    for (const privateOrSynthetic of [
      { subject: "Decision", body: "Message", recipientEmail: "other@example.com" },
      { subject: "Decision", body: "Message", recipientUserId: "other-user" },
      { subject: "Decision", body: "Message", idempotencyKey: "client-key" },
      { subject: "Decision", body: "Message", previewToken: "token" },
    ]) {
      expect(notificationQueueRequestSchema.safeParse(privateOrSynthetic).success).toBe(false);
    }
  });

  it("exposes owner-scoped lifecycle continuity without organizer or reviewer data", () => {
    const workspace = {
      event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
      proposals: [{
        id: proposal.id,
        publicId: proposal.publicId,
        title: proposal.title,
        status: "decided" as const,
        decision: "accept" as const,
        notificationStatus: "queued" as const,
        acceptedSession: {
          id: "session-1",
          slug: proposal.slug,
          title: proposal.title,
          track: "Developer Experience",
          format: "talk" as const,
          durationMinutes: 30,
          presenters: [{ speakerId: "speaker-1", name: "Proposal Owner", role: "primary" as const }],
          tasks: [{
            id: "task-1",
            taskKey: "confirm",
            label: "Confirm participation",
            state: "open" as const,
            completedAt: null,
          }],
        },
      }],
    };

    expect(ownerWorkspaceResponseSchema.safeParse(workspace).success).toBe(true);
    for (const privateField of [
      { rationale: "Organizer-only rationale" },
      { reviews: [{ comment: "Reviewer-only feedback" }] },
      { recipientEmail: "owner@example.com" },
    ]) {
      expect(ownerWorkspaceResponseSchema.safeParse({
        ...workspace,
        proposals: [{ ...workspace.proposals[0], ...privateField }],
      }).success).toBe(false);
    }
    expect(ownerWorkspaceResponseSchema.safeParse({
      ...workspace,
      proposals: [{
        ...workspace.proposals[0],
        decision: "reject",
      }],
    }).success).toBe(false);
    expect(ownerWorkspaceResponseSchema.safeParse({
      ...workspace,
      proposals: [{
        ...workspace.proposals[0],
        status: "submitted",
        decision: null,
        notificationStatus: "queued",
        acceptedSession: null,
      }],
    }).success).toBe(false);
  });

  it("requires proposal projections to state the exact decision or null", () => {
    const response = {
      id: proposal.id,
      publicId: proposal.publicId,
      status: "decided" as const,
      submittedAt: decidedAt,
      createdAt: decidedAt,
      updatedAt: decidedAt,
      clientDraftKey: null,
      decision: "reject" as const,
      values: {},
    };
    expect(proposalResponseSchema.safeParse(response).success).toBe(true);
    const { decision: _decision, ...missingDecision } = response;
    expect(proposalResponseSchema.safeParse(missingDecision).success).toBe(false);
    expect(proposalResponseSchema.safeParse({ ...response, decision: null }).success).toBe(false);
    expect(proposalResponseSchema.safeParse({
      ...response,
      status: "submitted",
      decision: "reject",
    }).success).toBe(false);
  });
});
