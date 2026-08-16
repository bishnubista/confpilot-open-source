import { describe, expect, it } from "vitest";

import { speakerClaimCreateResponseSchema, speakerClaimCreateSchema, speakerClaimRegisterSchema } from "./speaker-claims";

describe("speaker claim contracts", () => {
  it("defaults a bounded expiry and requires an exact speaker target", () => {
    expect(speakerClaimCreateSchema.parse({ speakerId: "speaker-1", idempotencyKey: "claim-key-1" }))
      .toEqual({ speakerId: "speaker-1", idempotencyKey: "claim-key-1", expiresInDays: 7 });
  });

  it("requires a bearer-sized token and password", () => {
    expect(speakerClaimRegisterSchema.safeParse({ token: "short", displayName: "Ada", password: "short" }).success).toBe(false);
  });

  it("separates the one-time claim link from the durable ledger", () => {
    const parsed = speakerClaimCreateResponseSchema.parse({
      claim: {
        id: "claim-1", speaker: { id: "speaker-1", name: "Ada Speaker" }, email: "ada@example.test",
        state: "pending", expiresAt: "2026-08-20T12:00:00Z", createdAt: "2026-08-13T12:00:00Z",
        updatedAt: "2026-08-13T12:00:00Z", acceptedAt: null, revokedAt: null, outboxState: "queued",
      },
      acceptPath: "/speaker-claim#abcdefghijklmnopqrstuvwxyz123456",
      replayed: false,
    });
    expect(parsed.acceptPath).toContain("#");
    expect(speakerClaimCreateResponseSchema.parse({ ...parsed, acceptPath: null, replayed: true }).acceptPath).toBeNull();
    expect(speakerClaimCreateResponseSchema.safeParse({ ...parsed, acceptPath: null, replayed: false }).success).toBe(false);
    expect(speakerClaimCreateResponseSchema.safeParse({ ...parsed, replayed: true }).success).toBe(false);
  });
});
