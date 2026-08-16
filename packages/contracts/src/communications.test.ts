import { describe, expect, it } from "vitest";

import {
  bulkSpeakerCommunicationEnqueueSchema,
  bulkSpeakerCommunicationResponseSchema,
  communicationHistoryResponseSchema,
} from "./communications";

const acceptedMessage = {
  id: "message-1",
  intent: "speaker_bulk",
  recipient: { name: "Ada Speaker", email: "ada@example.test" },
  subject: "Program update",
  transportStatus: "provider_accepted" as const,
  deliveryStatus: "unverified" as const,
  attemptCount: 1,
  provider: "cloudflare-email",
  providerMessageId: "provider-1",
  lastErrorCode: null,
  createdAt: "2026-08-13T09:00:00Z",
  updatedAt: "2026-08-13T09:01:00Z",
  providerAcceptedAt: "2026-08-13T09:01:00Z",
};

describe("communication contracts", () => {
  it("distinguishes provider acceptance from verified delivery", () => {
    expect(communicationHistoryResponseSchema.parse({
      capability: {
        enabled: true,
        provider: "cloudflare-email",
        reason: "configured",
        sendAfter: "2026-08-13T00:00:00Z",
      },
      messages: [acceptedMessage],
    }).messages[0]).toMatchObject({
      transportStatus: "provider_accepted",
      deliveryStatus: "unverified",
    });
    expect(communicationHistoryResponseSchema.safeParse({
      capability: {
        enabled: true,
        provider: "cloudflare-email",
        reason: "configured",
        sendAfter: "2026-08-13T00:00:00Z",
      },
      messages: [{ ...acceptedMessage, deliveryStatus: "not_attempted" }],
    }).success).toBe(false);
    expect(communicationHistoryResponseSchema.safeParse({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [{ ...acceptedMessage, attemptCount: 0 }],
    }).success).toBe(false);
  });

  it("distinguishes attempted-but-unverified failures from no attempt", () => {
    const attempted = {
      ...acceptedMessage,
      transportStatus: "failed" as const,
      deliveryStatus: "attempted_unverified" as const,
      providerAcceptedAt: null,
      providerMessageId: null,
      lastErrorCode: "E_REJECTED",
    };
    expect(communicationHistoryResponseSchema.parse({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [attempted],
    }).messages[0].deliveryStatus).toBe("attempted_unverified");
    expect(communicationHistoryResponseSchema.safeParse({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [{ ...attempted, deliveryStatus: "not_attempted" }],
    }).success).toBe(false);
    expect(communicationHistoryResponseSchema.safeParse({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [{ ...attempted, attemptCount: 0, deliveryStatus: "not_attempted" }],
    }).success).toBe(false);
  });

  it("requires a cancellation reason for suppressed transport", () => {
    const canceled = {
      ...acceptedMessage,
      transportStatus: "canceled" as const,
      deliveryStatus: "not_attempted" as const,
      attemptCount: 0,
      provider: null,
      providerMessageId: null,
      lastErrorCode: null,
      cancellationCode: "INVITATION_REVOKED",
      providerAcceptedAt: null,
    };
    expect(communicationHistoryResponseSchema.parse({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [canceled],
    }).messages[0].transportStatus).toBe("canceled");
    expect(communicationHistoryResponseSchema.safeParse({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [{ ...canceled, cancellationCode: null }],
    }).success).toBe(false);
  });

  it("preserves provider acceptance when cancellation raced an in-flight send", () => {
    expect(communicationHistoryResponseSchema.parse({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [{ ...acceptedMessage, cancellationCode: "INVITATION_REVOKED" }],
    }).messages[0]).toMatchObject({
      transportStatus: "provider_accepted",
      deliveryStatus: "unverified",
      cancellationCode: "INVITATION_REVOKED",
    });
  });

  it("requires an exact unique speaker selection", () => {
    expect(bulkSpeakerCommunicationEnqueueSchema.safeParse({
      speakerIds: ["speaker-1", "speaker-1"],
      subject: "Update",
      body: "Please review the latest program details.",
      idempotencyKey: "request-key-1",
    }).success).toBe(false);
  });

  it("allows only the documented communication merge tokens", () => {
    expect(bulkSpeakerCommunicationEnqueueSchema.safeParse({
      speakerIds: ["speaker-1"],
      subject: "{first_name}: {session_title}",
      body: "Open {portal_link}",
      idempotencyKey: "request-key-1",
    }).success).toBe(true);
    expect(bulkSpeakerCommunicationEnqueueSchema.safeParse({
      speakerIds: ["speaker-1"],
      subject: "Update",
      body: "Secret: {contact_email}",
      idempotencyKey: "request-key-1",
    }).success).toBe(false);
  });

  it("accounts for every requested recipient", () => {
    expect(bulkSpeakerCommunicationResponseSchema.safeParse({
      requestedCount: 2,
      queuedCount: 1,
      messageIds: ["message-1"],
      skipped: [],
    }).success).toBe(false);
    expect(bulkSpeakerCommunicationResponseSchema.parse({
      requestedCount: 2,
      queuedCount: 1,
      messageIds: ["message-1"],
      skipped: [{ speakerId: "speaker-2", reason: "contact_email_missing" }],
    }).requestedCount).toBe(2);
  });

  it("requires unique outcome identifiers for every accounted recipient", () => {
    expect(bulkSpeakerCommunicationResponseSchema.safeParse({
      requestedCount: 2,
      queuedCount: 2,
      messageIds: ["message-1", "message-1"],
      skipped: [],
    }).success).toBe(false);
    expect(bulkSpeakerCommunicationResponseSchema.safeParse({
      requestedCount: 2,
      queuedCount: 0,
      messageIds: [],
      skipped: [
        { speakerId: "speaker-1", reason: "contact_email_missing" },
        { speakerId: "speaker-1", reason: "contact_email_missing" },
      ],
    }).success).toBe(false);
  });
});
