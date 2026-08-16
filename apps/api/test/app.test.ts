import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index";
import { UPSTREAM_SOURCE_URL } from "../src/app/source-offer";
import type { Env } from "../src/types";

describe("ConfPilot API routing", () => {
  it("rejects a program request without an event before touching the database", async () => {
    const response = await createApp().request("/api/program");
    const body = await response.json<{ error: { code: string; requestId: string } }>();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("EVENT_REQUIRED");
    expect(body.error.requestId).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBe(body.error.requestId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns a consistent JSON error for unknown routes", async () => {
    const response = await createApp().request("/api/unknown");
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("rejects an organizer request without a session before reading the environment", async () => {
    const response = await createApp().request("/api/events/devflow-conf-2027/readiness");
    const body = await response.json<{ error: { code: string } }>();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("reports a degraded health response when the database probe fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const databaseError = new Error("database unavailable");
    const env = {
      DB: {
        prepare: () => {
          throw databaseError;
        },
      },
    };

    const response = await createApp().request("/api/health", undefined, env as never);
    const body = await response.json<{
      status: string;
      database: string;
      requestId: string;
    }>();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("unavailable");
    expect(body.requestId).toBeTruthy();
    expect(errorSpy).toHaveBeenCalledWith(
      "Health check database probe failed",
      { requestId: body.requestId, error: databaseError },
    );
    errorSpy.mockRestore();
  });

  it("reports a connected health response when the database probe succeeds", async () => {
    const env = {
      DB: {
        prepare: () => ({
          first: async () => ({ ok: 1 }),
        }),
      },
    };

    const response = await createApp().request("/api/health", undefined, env as unknown as Env);
    const body = await response.json<{
      status: string;
      service: string;
      database: string;
      requestId: string;
    }>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      service: "confpilot-api",
      database: "connected",
    });
    expect(body.requestId).toBeTruthy();
  });
});

describe("agent discovery document", () => {
  function environment(results: unknown[], extra: Record<string, string> = {}) {
    return { DB: { prepare: () => ({ all: async () => ({ results }) }) }, ...extra } as unknown as Env;
  }

  it("advertises each published event and its anonymous data endpoints", async () => {
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, environment([
      {
        slug: "devflow-conf-2027",
        name: "DevFlow Conf 2027",
        tagline: "The developer workflow conference",
        location: "San Francisco, CA",
        startsOn: "2027-06-10",
        endsOn: "2027-06-12",
      },
    ]));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(body.startsWith("# ConfPilot")).toBe(true);
    expect(body).toContain("**DevFlow Conf 2027**");
    expect(body).not.toContain("/events/devflow-conf-2027/program");
    expect(body).toContain("https://cfp.example.org/api/program?event=devflow-conf-2027");
    expect(body).toContain("https://cfp.example.org/api/program/speakers?event=devflow-conf-2027");
    expect(body).toContain("https://cfp.example.org/api/program.ics?event=devflow-conf-2027");
    expect(body).toContain("https://cfp.example.org/api/cfp/devflow-conf-2027");
  });

  it("is publicly cacheable rather than inheriting the private no-store default", async () => {
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, environment([]));

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("bounds the discovery index and reports omitted published events", async () => {
    const events = Array.from({ length: 51 }, (_, index) => ({
      slug: `event-${index + 1}`,
      name: `Event ${index + 1}`,
      tagline: "",
      location: "",
      startsOn: `2027-01-${String((index % 28) + 1).padStart(2, "0")}`,
      endsOn: `2027-01-${String((index % 28) + 1).padStart(2, "0")}`,
    }));
    let preparedSql = "";
    const env = {
      DB: {
        prepare: (sql: string) => {
          preparedSql = sql;
          return { all: async () => ({ results: events }) };
        },
      },
    } as unknown as Env;
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, env);
    const body = await response.text();

    expect(preparedSql).toMatch(/ORDER BY starts_on DESC\s+LIMIT 51/);
    expect(body).toContain("Additional published events are omitted from this bounded index.");
    expect(body.match(/— sessions and speakers \(JSON\)/g)).toHaveLength(50);
  });

  it("publishes the AGPL source offer, defaulting to upstream", async () => {
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, environment([]));
    const body = await response.text();

    expect(body).toContain(UPSTREAM_SOURCE_URL);
    expect(body).toContain("AGPL-3.0-or-later");
  });

  it("lets an operator point the source offer at their own fork", async () => {
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, environment([], {
      SOURCE_URL: "https://git.example.org/ops/confpilot-fork",
    }));
    const body = await response.text();

    expect(body).toContain("https://git.example.org/ops/confpilot-fork");
    expect(body).not.toContain(UPSTREAM_SOURCE_URL);
  });

  it("fails closed when the configured source URL is not http or https", async () => {
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, environment([], {
      SOURCE_URL: "javascript:alert(1)",
    }));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain(UPSTREAM_SOURCE_URL);
    expect(body).toContain("SOURCE_URL is invalid");
  });

  it.each([
    "https://operator@git.example.org/ops/confpilot-fork",
    "https://operator:secret@git.example.org/ops/confpilot-fork",
  ])("fails closed for a source URL containing userinfo: %s", async (configuredSourceUrl) => {
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, environment([], {
      SOURCE_URL: configuredSourceUrl,
    }));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).not.toContain("operator");
    expect(body).not.toContain("secret");
    expect(body).not.toContain(UPSTREAM_SOURCE_URL);
  });

  it("says so plainly when no event is published yet", async () => {
    const response = await createApp().request("https://cfp.example.org/llms.txt", undefined, environment([]));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("No published events yet.");
    expect(body).not.toContain("/api/program?event=");
  });
});
