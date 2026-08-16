import {
  contentReviewCreateSchema,
  deliverableUploadMetadataSchema,
  speakerReminderEnqueueSchema,
} from "@confpilot/contracts";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/index";
import { agentOperations, retryModeDescriptions } from "../src/app/agent-manifest";
import { featureManifest } from "../src/app/feature-manifest";
import type { Env } from "../src/types";

/** Every concrete route the composed app actually registers, as `METHOD path`. */
function registeredRoutes() {
  return new Set(
    createApp().routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  );
}

function catalogued() {
  return new Set(agentOperations.map((operation) => `${operation.method} ${operation.path}`));
}

/**
 * The catalog is hand-written metadata about generated behaviour, so it can
 * drift in two directions: a new route nobody annotated, or an annotation for a
 * route that no longer exists. Both are failures, and both are checked here
 * rather than trusted.
 */
describe("agent operation catalog", () => {
  it("annotates every route the app registers", () => {
    const missing = [...registeredRoutes()].filter((route) => !catalogued().has(route)).sort();

    expect(missing, "add these to agentOperations in app/agent-manifest.ts").toEqual([]);
  });

  it("describes no operation the app does not register", () => {
    const registered = registeredRoutes();
    const stale = [...catalogued()].filter((route) => !registered.has(route)).sort();

    expect(stale, "remove these from agentOperations in app/agent-manifest.ts").toEqual([]);
  });

  it("gives every operation a unique, stable id", () => {
    const ids = agentOperations.map((operation) => operation.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only lifecycle stages the feature manifest declares", () => {
    const stages = new Set(featureManifest.map((feature) => feature.name));
    const unknown = [...new Set(agentOperations.map((operation) => operation.stage))]
      .filter((stage) => !stages.has(stage))
      .sort();

    expect(unknown).toEqual([]);
  });

  it("describes every retry mode it uses", () => {
    const undescribed = agentOperations
      .filter((operation) => retryModeDescriptions[operation.retry] === undefined)
      .map((operation) => operation.id);

    expect(undescribed).toEqual([]);
  });

  it("does not claim a repeated sign-in replays an existing session", () => {
    const signIn = agentOperations.find((operation) => operation.id === "identity.signIn");

    expect(signIn?.retry).toBe("unsafe");
    expect(signIn?.summary).toContain("may create another session");
  });

  it("locates the idempotency key exactly when the retry mode depends on one", () => {
    const mismatched = agentOperations
      .filter((operation) =>
        (operation.retry === "idempotency-key") !== (operation.idempotency !== undefined))
      .map((operation) => operation.id);

    expect(mismatched).toEqual([]);
  });

  it("points a keyed upload at the header and a keyed JSON write at the body", () => {
    const byId = new Map(agentOperations.map((operation) => [operation.id, operation]));

    // Multipart uploads have no JSON body to carry the key, so the route reads a header.
    expect(byId.get("speakers.uploadDeliverable")?.idempotency)
      .toEqual({ in: "header", name: "Idempotency-Key", required: true });
    expect(byId.get("speakers.queueReminders")?.idempotency)
      .toEqual({ in: "body", name: "idempotencyKey", required: true });
    expect(byId.get("speakers.reviewDeliverable")?.idempotency)
      .toEqual({ in: "body", name: "idempotencyKey", required: true });
  });

  /**
   * The body-field claims are only worth publishing if they match the schema the
   * route actually validates against, so they are checked against it rather than
   * against the manifest's own wording.
   */
  it("names a body field the request schema genuinely requires", () => {
    const reminderWithoutKey = speakerReminderEnqueueSchema.safeParse({
      speakerId: "speaker:devflow-conf-2027:sanaa",
      templateKey: "onboarding_tasks_outstanding",
    });
    const reviewWithoutKey = contentReviewCreateSchema.safeParse({
      versionId: "deliverable-version:devflow-conf-2027:1",
      outcome: "approved",
      comment: "Looks good.",
      expectedSessionRevision: 1,
    });

    expect(reminderWithoutKey.success).toBe(false);
    expect(reviewWithoutKey.success).toBe(false);
    expect(deliverableUploadMetadataSchema.safeParse({ note: "" }).success).toBe(false);
  });

  it("never marks a read as needing human approval", () => {
    const overreach = agentOperations
      .filter((operation) => operation.method === "GET" && operation.approval === "human")
      .map((operation) => operation.id);

    expect(overreach).toEqual([]);
  });

  it("requires human approval before publishing, notifying, or deciding a proposal", () => {
    const gated = new Set(
      agentOperations.filter((operation) => operation.approval === "human").map((o) => o.id),
    );

    for (const id of [
      "agenda.publish",
      "decisions.record",
      "decisions.queueNotification",
      "review.submitScorecard",
      "speakers.queueReminders",
      "speakers.setContentApproval",
      "publication.createEmbed",
    ]) {
      expect(gated, `${id} must stay behind a human approval gate`).toContain(id);
    }
  });
});

describe("agent manifest document", () => {
  const environment = (extra: Record<string, string> = {}) => ({ ...extra }) as unknown as Env;

  it("is served anonymously and reads nothing from the database", async () => {
    const env = {
      DB: {
        prepare: () => {
          throw new Error("the agent manifest must not query the database");
        },
      },
    } as unknown as Env;
    const response = await createApp().request("https://cfp.example.org/api/agent/manifest", undefined, env);

    expect(response.status).toBe(200);
  });

  it("publishes the operation catalog with the instance origin", async () => {
    const response = await createApp().request(
      "https://cfp.example.org/api/agent/manifest",
      undefined,
      environment(),
    );
    const body = await response.json<{
      confpilotAgentManifest: number;
      instance: { origin: string; source: string; anonymousIndex: string };
      operations: Array<{ id: string; path: string }>;
    }>();

    expect(body.confpilotAgentManifest).toBe(1);
    expect(body.instance.origin).toBe("https://cfp.example.org");
    expect(body.instance.anonymousIndex).toBe("https://cfp.example.org/llms.txt");
    expect(body.operations.length).toBe(agentOperations.length);
    expect(body.operations.some((operation) => operation.id === "platform.readiness")).toBe(true);
  });

  it("states the same-origin preamble a non-browser client must send", async () => {
    const response = await createApp().request(
      "https://cfp.example.org/api/agent/manifest",
      undefined,
      environment(),
    );
    const body = await response.json<{
      mutationPreamble: { headers: Record<string, string>; notes: string[] };
      authentication: { cookie: string; lifetimeSeconds: number };
    }>();

    expect(body.mutationPreamble.headers["x-confpilot-request"]).toBe("1");
    expect(body.mutationPreamble.headers.origin).toBe("https://cfp.example.org");
    expect(body.authentication.cookie).toBe("__Host-confpilot_session");
    expect(body.authentication.lifetimeSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("is publicly cacheable rather than inheriting the private no-store default", async () => {
    const response = await createApp().request(
      "https://cfp.example.org/api/agent/manifest",
      undefined,
      environment(),
    );

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("publishes the AGPL source offer and follows an operator fork", async () => {
    const upstream = await createApp().request(
      "https://cfp.example.org/api/agent/manifest",
      undefined,
      environment(),
    );
    const forked = await createApp().request(
      "https://cfp.example.org/api/agent/manifest",
      undefined,
      environment({ SOURCE_URL: "https://git.example.org/ops/confpilot-fork" }),
    );

    expect((await upstream.json<{ instance: { source: string } }>()).instance.source)
      .toBe("https://github.com/bishnubista/confpilot-open-source");
    expect((await forked.json<{ instance: { source: string } }>()).instance.source)
      .toBe("https://git.example.org/ops/confpilot-fork");
  });

  it.each([
    "javascript:alert(1)",
    "https://operator:secret@git.example.org/ops/confpilot-fork",
  ])("fails closed for an unusable source URL: %s", async (configuredSourceUrl) => {
    const response = await createApp().request(
      "https://cfp.example.org/api/agent/manifest",
      undefined,
      environment({ SOURCE_URL: configuredSourceUrl }),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("javascript:");
  });
});

/**
 * The manifest is only useful if the preamble it documents is the one the API
 * actually enforces. These drive the real middleware rather than restating it.
 */
describe("the documented preamble is the one the API enforces", () => {
  const target = "https://cfp.example.org/api/events/devflow-conf-2027/decisions";

  it("rejects a mutation that omits the documented headers", async () => {
    const response = await createApp().request(
      target,
      { method: "POST", body: "{}" },
      {} as unknown as Env,
    );
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("UNSAFE_REQUEST_REJECTED");
  });

  it("lets a non-browser client past the guard when it sends them", async () => {
    const response = await createApp().request(
      target,
      {
        method: "POST",
        headers: {
          origin: "https://cfp.example.org",
          "x-confpilot-request": "1",
          "content-type": "application/json",
        },
        body: "{}",
      },
      {} as unknown as Env,
    );
    const body = await response.json<{ error: { code: string } }>();

    // Past the same-origin guard, so the next gate is authentication rather than 403.
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });
});
