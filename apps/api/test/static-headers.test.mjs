/**
 * Keep the header policy, the committed `_headers`, and the Node matcher in step.
 *
 * Three things have to agree, or the policy silently differs by host:
 *
 * 1. what `security-headers.ts` renders, and what is committed at
 *    `apps/web/public/_headers` — Cloudflare reads the file, nothing else does;
 * 2. what `headersForPath` resolves, and what parsing that file yields — a Node
 *    host uses the function, so a divergence means one host is less protected;
 * 3. that the route-specific rules still say what they are supposed to say.
 *
 * The third matters most and is the easiest to lose: authenticated surfaces must
 * deny framing, and public embeds must *not*, because organizers frame their
 * program in their own sites.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { headersForPath, renderStaticHeadersFile } from "../src/runtime/security-headers.ts";

const committedHeaders = readFileSync(new URL("../../web/public/_headers", import.meta.url), "utf8");

/**
 * Resolve headers by parsing the committed file the way Cloudflare does.
 *
 * Deliberately a second, independent implementation: comparing `headersForPath`
 * against itself would prove nothing.
 */
function parseHeadersFile(path) {
  const resolved = new Map();
  for (const block of committedHeaders.split(/\n\s*\n/)) {
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
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      resolved.set(name, resolved.has(name) ? `${resolved.get(name)}, ${value}` : value);
    }
  }
  return resolved;
}

const REPRESENTATIVE_PATHS = [
  "/",
  "/submit",
  "/events/community-conf/submit",
  "/admin",
  "/admin/agenda",
  "/events/community-conf/admin/agenda",
  "/reviewer",
  "/events/community-conf/reviewer/queue",
  "/speaker-portal",
  "/events/community-conf/speaker",
  "/events/community-conf/submit/prop-42",
  "/reviewer-invitation",
  "/speaker-claim",
  "/embed/devflow-conf-2027/homepage-agenda",
  "/events/community-conf/embed/homepage-agenda",
  "/assets/index-iJ4H1SlM.js",
  "/llms.txt",
];

describe("static header policy", () => {
  it("renders exactly the committed _headers file", () => {
    // If this fails, run `node scripts/generate-static-headers.mjs` and commit.
    expect(renderStaticHeadersFile()).toBe(committedHeaders);
  });

  it("resolves the same headers as parsing the file, on every representative path", () => {
    for (const path of REPRESENTATIVE_PATHS) {
      const fromModule = Object.fromEntries([...headersForPath(path)].sort());
      const fromFile = Object.fromEntries([...parseHeadersFile(path)].sort());
      expect(fromModule, `headers diverge for ${path}`).toEqual(fromFile);
    }
  });

  it("denies framing on every authenticated or credential-bearing surface", () => {
    // The last three were unprotected before this policy was extracted: the
    // proposal-detail submit form, and the two single-use token flows that
    // create an account and set a session. Each is served by App.tsx.
    for (const path of [
      "/admin", "/admin/agenda", "/events/community-conf/admin/agenda",
      "/reviewer", "/events/community-conf/reviewer/queue",
      "/reviewer/assignments/asg-1",
      "/speaker-portal", "/events/community-conf/speaker",
      "/submit", "/events/community-conf/submit",
      "/events/community-conf/submit/prop-42",
      "/reviewer-invitation",
      "/speaker-claim",
    ]) {
      const headers = headersForPath(path);
      expect(headers.get("x-frame-options"), `${path} must deny framing`).toBe("DENY");
      expect(headers.get("content-security-policy"), `${path} must deny framing`)
        .toContain("frame-ancestors 'none'");
    }
  });

  it("denies framing on the trailing-slash form of every workspace route", () => {
    // Anchored patterns do not tolerate a trailing slash, and the SPA router does:
    // `/events/:event/speaker/` matches with an empty detail segment, which is
    // falsy, so App.tsx renders the authenticated speaker portal there. Every
    // other workspace happened to be covered by its own `/*` entry, which matches
    // the empty remainder after the slash. The speaker workspace had none,
    // because it takes no detail — so it alone fell outside the policy.
    for (const path of [
      "/events/community-conf/speaker/",
      "/events/community-conf/admin/",
      "/events/community-conf/reviewer/",
      "/events/community-conf/submit/",
      "/admin/",
      "/reviewer/",
    ]) {
      const headers = headersForPath(path);
      expect(headers.get("x-frame-options"), `${path} must deny framing`).toBe("DENY");
      expect(headers.get("content-security-policy"), `${path} must deny framing`)
        .toContain("frame-ancestors 'none'");
    }
  });

  it("resolves pathnames only, so callers must strip the query", () => {
    // Patterns are anchored. A caller passing a full URL would match nothing and
    // silently receive the base policy for a route that should deny framing.
    expect(headersForPath("/submit").get("x-frame-options")).toBe("DENY");
    expect(headersForPath("/submit?token=abc").has("x-frame-options")).toBe(false);
    expect(headersForPath(new URL("https://example.test/submit?token=abc").pathname)
      .get("x-frame-options")).toBe("DENY");
  });

  it("leaves public embeds framable", () => {
    // Organizers embed their published program in their own sites. A blanket
    // frame denial would break every one of them.
    for (const path of [
      "/embed/devflow-conf-2027/homepage-agenda",
      "/events/community-conf/embed/homepage-agenda",
    ]) {
      const headers = headersForPath(path);
      expect(headers.has("x-frame-options"), `${path} must stay framable`).toBe(false);
      expect(headers.get("content-security-policy") ?? "").not.toContain("frame-ancestors");
    }
  });

  it("keeps the Turnstile origin allowed wherever the widget renders", () => {
    // The CFP form is frame-denied but still has to load the challenge.
    const csp = headersForPath("/submit").get("content-security-policy");
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("connect-src 'self' https://challenges.cloudflare.com");
  });

  it("caches only content-hashed assets immutably", () => {
    expect(headersForPath("/assets/index-iJ4H1SlM.js").get("cache-control"))
      .toBe("public, max-age=31536000, immutable");
    for (const path of ["/", "/index.html", "/submit", "/admin"]) {
      expect(headersForPath(path).has("cache-control"), `${path} must not be cached immutably`).toBe(false);
    }
  });
});
