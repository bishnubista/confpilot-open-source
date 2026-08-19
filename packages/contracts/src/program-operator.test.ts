import { describe, expect, it } from "vitest";

import { programOperatorBriefResponseSchema } from "./program-operator";

const brief = {
  event: { id: "evt-1", slug: "event-1", name: "Event 1" },
  snapshot: {
    schemaVersion: 1,
    capturedAt: "2027-05-01T12:00:00Z",
    staleLeaseBefore: "2027-04-30T12:00:00Z",
    fingerprint: "a".repeat(64),
    evidenceCount: 1,
  },
  generation: {
    mode: "deterministic",
    modelStatus: "not_configured",
    policyVersion: "program-operator-shadow-v1",
  },
  summary: {
    status: "attention_needed",
    acceptedSessions: 1,
    publishReadySessions: 0,
    riskCount: 1,
    reminderDraftCount: 1,
    exceptionCount: 0,
  },
  evidence: [{ id: "speaker:spk-1", source: "speaker", recordId: "spk-1", fields: ["contactEmail"] }],
  risks: [{
    id: "risk-1",
    rank: 1,
    severity: "high",
    kind: "readiness_blocker",
    title: "Speaker is not ready",
    explanation: "The canonical speaker profile is incomplete.",
    suggestedResolution: "Ask the speaker to complete the profile.",
    affectedRecords: [{ type: "speaker", id: "spk-1", label: "Speaker One" }],
    evidenceIds: ["speaker:spk-1"],
    confidence: "high",
  }],
  plan: [{
    id: "draft-1",
    kind: "speaker_reminder",
    status: "draft",
    requiredApproval: "human",
    queueOperation: "speakers.queueReminders",
    recipient: { type: "speaker", id: "spk-1", name: "Speaker One", email: "speaker@example.test" },
    draft: {
      templateKey: "speaker.readiness-reminder",
      templateRevision: 2,
      subject: "Readiness reminder",
      text: "Please complete the cited readiness work.",
    },
    expectedStateChange: "A message would be queued after approval; readiness would not change until the speaker acts.",
    evidenceIds: ["speaker:spk-1"],
  }],
  exceptions: [],
  guardrails: { shadowMode: true, writesPerformed: 0, unauthorizedActions: 0 },
} as const;

describe("Program Operator brief contract", () => {
  it("accepts a grounded, approval-gated shadow brief", () => {
    expect(programOperatorBriefResponseSchema.safeParse(brief).success).toBe(true);
  });

  it("rejects facts that cite evidence outside the snapshot", () => {
    const invalid = JSON.parse(JSON.stringify(brief)) as {
      risks: Array<{ evidenceIds: string[] }>;
    };
    invalid.risks[0].evidenceIds = ["speaker:another-event"];

    const result = programOperatorBriefResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["risks", 0, "evidenceIds"],
        message: "Unknown evidence reference: speaker:another-event",
      }));
    }
  });

  it("rejects summary counts or ranks that do not match the payload", () => {
    const invalid = JSON.parse(JSON.stringify(brief)) as {
      summary: { riskCount: number };
      risks: Array<{ rank: number }>;
    };
    invalid.summary.riskCount = 2;
    invalid.risks[0].rank = 2;

    expect(programOperatorBriefResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
