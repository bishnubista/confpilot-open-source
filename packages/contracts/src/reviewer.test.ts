import { describe, expect, it } from "vitest";

import {
  blindReviewProposalSchema,
  evaluationPlanWriteSchema,
  organizerProposalReviewProgressSchema,
  organizerReviewAssignmentCreateSchema,
  reviewerAssignmentDetailResponseSchema,
  reviewScorecardSubmitSchema,
} from "./index";

const proposal = {
  publicId: "ABS-301",
  title: "Evidence-First Program Reviews",
  abstract: "A practical proposal about defensible review workflows.",
  track: "Developer Experience",
  format: "talk" as const,
  durationMinutes: 30,
  sessionAnswers: { key_takeaway: "Keep review evidence connected to the proposal." },
};

describe("review workflow contracts", () => {
  it("defaults organizer assignments to blind and requires UTC-second due dates", () => {
    expect(organizerReviewAssignmentCreateSchema.parse({ reviewerUserId: "reviewer-1" }))
      .toEqual({ reviewerUserId: "reviewer-1", blind: true });
    expect(organizerReviewAssignmentCreateSchema.safeParse({
      reviewerUserId: "reviewer-1",
      dueAt: "2027-04-20T17:00:00Z",
      blind: false,
    }).success).toBe(true);
    expect(organizerReviewAssignmentCreateSchema.safeParse({
      reviewerUserId: "reviewer-1",
      dueAt: "2027-04-20T17:00:00.100Z",
    }).success).toBe(false);
  });

  it("keeps the scorecard strict, bounded, and normalized", () => {
    expect(reviewScorecardSubmitSchema.parse({
      expectedRevision: 2,
      originality: 4,
      relevance: 5,
      recommendation: "accept",
      comment: "  Clear evidence and a focused takeaway.  ",
    })).toMatchObject({ expectedRevision: 2, comment: "Clear evidence and a focused takeaway." });
    for (const invalid of [
      { originality: 0, relevance: 5, recommendation: "accept", comment: "Useful." },
      { originality: 4.5, relevance: 5, recommendation: "accept", comment: "Useful." },
      { originality: 4, relevance: 6, recommendation: "accept", comment: "Useful." },
      { originality: 4, relevance: 5, recommendation: "maybe", comment: "Useful." },
      { originality: 4, relevance: 5, recommendation: "accept", comment: "   " },
      { originality: 4, relevance: 5, recommendation: "accept", comment: "Useful.", extra: true },
      { expectedRevision: 0, originality: 4, relevance: 5, recommendation: "accept", comment: "Useful." },
      {
        criterionScores: [
          { criterionId: "criterion-1", score: 4 },
          { criterionId: "criterion-1", score: 5 },
        ],
        recommendation: "accept",
        comment: "Useful.",
      },
    ]) {
      expect(reviewScorecardSubmitSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires unique criteria whose integer basis-point weights total exactly 10000", () => {
    const valid = {
      name: "Program rubric",
      criteria: [
        { key: "evidence", label: "Evidence", description: "", weightBasisPoints: 3333, minimumScore: 1, maximumScore: 5 },
        { key: "impact", label: "Impact", description: "", weightBasisPoints: 6667, minimumScore: 1, maximumScore: 5 },
      ],
    };
    expect(evaluationPlanWriteSchema.safeParse(valid).success).toBe(true);
    expect(evaluationPlanWriteSchema.safeParse({
      ...valid,
      criteria: valid.criteria.map((criterion) => ({ ...criterion, weightBasisPoints: 5001 })),
    }).success).toBe(false);
    expect(evaluationPlanWriteSchema.safeParse({
      ...valid,
      criteria: valid.criteria.map((criterion) => ({ ...criterion, key: "duplicate" })),
    }).success).toBe(false);
  });

  it("accepts organizer aggregates on the canonical comparable score range", () => {
    const valid = {
      proposalId: "proposal-1",
      publicId: "ABS-301",
      title: "Evidence-First Program Reviews",
      track: "Developer Experience",
      format: "talk",
      assignedCount: 1,
      completedCount: 1,
      averageScore: 5,
      recommendations: { accept: 1, discuss: 0, reject: 0 },
    };
    expect(organizerProposalReviewProgressSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { averageScore: 5.5 },
      { averageScore: -1 },
      { recommendations: { accept: -1, discuss: 0, reject: 0 } },
      { completedCount: -1 },
    ]) {
      expect(organizerProposalReviewProgressSchema.safeParse({ ...valid, ...invalid }).success).toBe(false);
    }
  });

  it("structurally rejects author and ownership data from blind proposals", () => {
    expect(blindReviewProposalSchema.parse(proposal)).toEqual(proposal);
    for (const privateField of [
      { authorDisplayName: "Private Speaker" },
      { owner: { name: "Private Speaker", email: "private@example.com" } },
      { email: "private@example.com" },
      { clientDraftKey: "private-draft-key" },
      { presenters: [{ name: "Private Speaker" }] },
    ]) {
      expect(blindReviewProposalSchema.safeParse({ ...proposal, ...privateField }).success).toBe(false);
    }
  });

  it("allows an author display name only on explicitly non-blind detail projections", () => {
    const base = {
      id: "assignment-1",
      round: 1,
      dueAt: null,
      status: "pending" as const,
      invitationStatus: "accepted" as const,
      review: null,
    };
    expect(reviewerAssignmentDetailResponseSchema.safeParse({
      ...base,
      blind: true,
      proposal,
    }).success).toBe(true);
    expect(reviewerAssignmentDetailResponseSchema.safeParse({
      ...base,
      blind: true,
      proposal: { ...proposal, authorDisplayName: "Private Speaker" },
    }).success).toBe(false);
    expect(reviewerAssignmentDetailResponseSchema.safeParse({
      ...base,
      blind: false,
      proposal: { ...proposal, authorDisplayName: "Visible Speaker" },
    }).success).toBe(true);
    expect(reviewerAssignmentDetailResponseSchema.safeParse({
      ...base,
      blind: false,
      proposal,
    }).success).toBe(true);
    for (const invalidDiscriminator of [{}, { blind: 1 }, { blind: "true" }]) {
      expect(reviewerAssignmentDetailResponseSchema.safeParse({
        ...base,
        ...invalidDiscriminator,
        proposal,
      }).success).toBe(false);
    }
  });
});
