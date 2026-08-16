import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { createApp, responseSecurityHeaders } from "../src/index.ts";
import { LOGIN_RATE_LIMITS } from "../src/runtime/rate-limiter.ts";

function readWorkerConfig() {
  const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
}

function readStaticHeaders() {
  return readFileSync(new URL("../../web/public/_headers", import.meta.url), "utf8");
}

function readDevVariableNames() {
  return new Set(readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean));
}

function effectiveHeaders(path) {
  const blocks = readStaticHeaders().split(/\n\s*\n/);
  const result = new Map();
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    const pattern = lines[0]?.trim();
    if (!pattern?.startsWith("/")) continue;
    const expression = new RegExp(`^${pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/:[a-zA-Z][a-zA-Z0-9_]*/g, "[^/]+")
      .replace(/\\\*/g, ".*")}$`);
    if (!expression.test(path)) continue;
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator > 0) {
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        result.set(name, result.has(name) ? `${result.get(name)}, ${value}` : value);
      }
    }
  }
  return result;
}

describe("same-origin Worker configuration", () => {
  it("serves the Vite SPA and routes API requests through one Worker", () => {
    const config = readWorkerConfig();

    expect(config.name).toBe("confpilot");
    expect(config.main).toBe("src/index.ts");
    expect(config.observability).toEqual({ enabled: true, head_sampling_rate: 1 });
    expect(config.limits).toEqual({ cpu_ms: 1000 });
    expect(config.send_email).toEqual([{ name: "EMAIL" }]);
    expect(config.triggers).toEqual({ crons: ["*/5 * * * *"] });
    expect(config.vars).toEqual({ CLIENT_IP_SOURCE: "cloudflare", EMAIL_DELIVERY_ENABLED: "false" });
    // Throttling attributes a caller by cf-connecting-ip, which is only
    // unforgeable because Cloudflare's edge overwrites it. The Worker has to say
    // so explicitly: the code defaults to trusting nothing, so dropping this var
    // would silently collapse every caller into one shared bucket.
    expect(config.vars.CLIENT_IP_SOURCE).toBe("cloudflare");
    expect(config.assets).toEqual({
      directory: "../web/dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/llms.txt"],
    });
    expect(config.d1_databases).toEqual([
      expect.objectContaining({
        binding: "DB",
        database_name: "confpilot-db",
        migrations_dir: "migrations",
      }),
    ]);
    expect(config.r2_buckets).toEqual([
      { binding: "FILES", bucket_name: "confpilot-files" },
    ]);
    expect(config.ratelimits).toEqual([
      {
        name: "LOGIN_SOURCE_RATE_LIMITER",
        namespace_id: "1001",
        simple: { limit: 20, period: 60 },
      },
      {
        name: "LOGIN_ACCOUNT_RATE_LIMITER",
        namespace_id: "1002",
        simple: { limit: 5, period: 60 },
      },
    ]);
    // The same numbers the Node host builds its limiters from. Two copies of a
    // security parameter drift silently, and the symptom would be a deployment
    // that throttles logins more loosely than the one it was tested on.
    expect(config.ratelimits.map(({ name, simple }) => ({ name, ...simple }))).toEqual(
      Object.values(LOGIN_RATE_LIMITS).map(({ binding, limit, periodSeconds }) =>
        ({ name: binding, limit, period: periodSeconds })),
    );
    expect(config.account_id).toBeUndefined();
    expect(config.vars?.CALENDAR_UID_DOMAIN).toBeUndefined();
    expect(config.d1_databases[0].database_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("documents email delivery inputs locally without pinning deployment identities", () => {
    const config = readWorkerConfig();
    const localVariables = readDevVariableNames();

    for (const name of [
      "EMAIL_DELIVERY_ENABLED",
      "EMAIL_DELIVERY_SEND_AFTER",
      "EMAIL_FROM_ADDRESS",
      "EMAIL_FROM_NAME",
    ]) expect(localVariables.has(name), `${name} must be documented in .dev.vars.example`).toBe(true);
    expect(config.vars).toEqual({ CLIENT_IP_SOURCE: "cloudflare", EMAIL_DELIVERY_ENABLED: "false" });
  });

  it("caches content-hashed assets immutably", () => {
    // Every filename Vite emits under /assets/ carries a content hash, so the
    // URL is permanently 1:1 with its bytes.
    expect(effectiveHeaders("/assets/index-iJ4H1SlM.js").get("cache-control"))
      .toBe("public, max-age=31536000, immutable");
    expect(effectiveHeaders("/assets/index-DVW-a31P.css").get("cache-control"))
      .toBe("public, max-age=31536000, immutable");
  });

  it("leaves every unhashed path on the revalidating default", () => {
    // The SPA fallback serves index.html for unknown paths. If any of these
    // picked up immutable caching, a deploy would not reach open browsers, and
    // a stale shell would be pinned for a year. Asset serving must stay the
    // only immutable surface.
    for (const path of ["/", "/index.html", "/program", "/events/devflow-conf-2027/program", "/robots.txt", "/admin"]) {
      expect(effectiveHeaders(path).has("cache-control"), `${path} must not set Cache-Control`).toBe(false);
    }
  });

  it("keeps nosniff on hashed assets so an HTML fallback can never execute as a module", () => {
    // This is what makes immutable caching safe above: if a stale asset URL
    // falls through to index.html, the browser refuses to run text/html as
    // JavaScript instead of caching it as a script for a year.
    expect(effectiveHeaders("/assets/index-iJ4H1SlM.js").get("x-content-type-options")).toBe("nosniff");
  });

  it("sets an HTTPS-only baseline and a restrictive CSP on the public shell", () => {
    const rootHeaders = effectiveHeaders("/");
    expect(rootHeaders.get("strict-transport-security")).toBe("max-age=31536000");
    expect(rootHeaders.get("content-security-policy")).toBe("default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'");
  });

  it("sets HSTS on Worker-generated API responses as well as static assets", async () => {
    const response = await createApp().request("/api/health", undefined, {
      DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
    });
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("adds security headers after a handler returns a raw Response", async () => {
    const app = new Hono();
    app.use("*", responseSecurityHeaders);
    app.get("/raw", () => new Response("private bytes", {
      headers: { "content-type": "application/octet-stream" },
    }));

    const response = await app.request("/raw");

    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toMatch(/\S+/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("blocks framing on authenticated surfaces while leaving public embeds framable", () => {
    const headers = readStaticHeaders();
    for (const route of [
      "/admin", "/admin/*", "/reviewer", "/reviewer/*", "/speaker-portal",
      "/events/:event/admin", "/events/:event/admin/*", "/events/:event/reviewer",
      "/events/:event/reviewer/*", "/events/:event/speaker",
    ]) {
      expect(headers).toContain(`${route}\n  Content-Security-Policy: frame-ancestors 'none'\n  X-Frame-Options: DENY`);
    }
    const submitHeaders = effectiveHeaders("/submit");
    expect(submitHeaders.get("strict-transport-security")).toBe("max-age=31536000");
    expect(submitHeaders.get("content-security-policy")).toBe("default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self', frame-ancestors 'none'");
    expect(submitHeaders.get("x-frame-options")).toBe("DENY");
    const canonicalSubmitHeaders = effectiveHeaders("/events/community-conf/submit");
    expect(canonicalSubmitHeaders.get("content-security-policy")).toBe(submitHeaders.get("content-security-policy"));
    expect(canonicalSubmitHeaders.get("x-frame-options")).toBe("DENY");
    const canonicalAdminHeaders = effectiveHeaders("/events/community-conf/admin/agenda");
    expect(canonicalAdminHeaders.get("content-security-policy")).toBe(`${effectiveHeaders("/").get("content-security-policy")}, frame-ancestors 'none'`);
    expect(canonicalAdminHeaders.get("x-frame-options")).toBe("DENY");
    const embedHeaders = effectiveHeaders("/embed/devflow-conf-2027/homepage-agenda");
    expect(embedHeaders.get("content-security-policy") ?? "").not.toContain("frame-ancestors 'none'");
    expect(embedHeaders.has("x-frame-options")).toBe(false);
    const canonicalEmbedHeaders = effectiveHeaders("/events/community-conf/embed/homepage-agenda");
    expect(canonicalEmbedHeaders.get("content-security-policy") ?? "").not.toContain("frame-ancestors 'none'");
    expect(canonicalEmbedHeaders.has("x-frame-options")).toBe(false);
  });
});
