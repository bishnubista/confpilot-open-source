/**
 * Pin the trust rules for caller attribution.
 *
 * Whatever this resolves to is what a rate limiter counts against, so an error
 * is a security bug in either direction: believe a forgeable header and an
 * attacker rotates it to bypass per-source throttling; ignore a legitimate one
 * and unrelated users share a bucket.
 *
 * The central property is that **no header is trusted unless the deployment
 * declared what sits in front of it**. `cf-connecting-ip` is not special: it is
 * unforgeable on Cloudflare because the edge overwrites it, which is a fact about
 * the deployment rather than the header.
 */
import { describe, expect, it } from "vitest";

import { clientIp, requestSource, resolveClientIpSource, UNATTRIBUTED_SOURCE } from "../src/runtime/client-ip";

function headers(values: Record<string, string>) {
  return { header: (name: string) => values[name.toLowerCase()] };
}

const forgedEverything = headers({
  "cf-connecting-ip": "203.0.113.7",
  "x-forwarded-for": "198.51.100.1",
});

describe("resolveClientIpSource", () => {
  it("accepts only the two declared fronts", () => {
    expect(resolveClientIpSource("cloudflare")).toBe("cloudflare");
    expect(resolveClientIpSource("forwarded")).toBe("forwarded");
  });

  it("falls back to trusting nothing for anything else", () => {
    // Fail closed: a typo, a stale value, or an unset variable must not grant
    // trust to a header the deployment never vouched for.
    for (const value of [undefined, "", "none", "true", "TRUE", "1", "Cloudflare", "cf"]) {
      expect(resolveClientIpSource(value), `${String(value)} must not grant trust`).toBe("none");
    }
  });
});

describe("clientIp", () => {
  it("ignores every header when nothing is declared in front", () => {
    // The bug this pins: a self-hosted instance that trusts cf-connecting-ip
    // because Cloudflare would. Off Cloudflare that header is attacker-supplied,
    // and honouring it hands out a fresh throttling bucket per forged value.
    expect(clientIp(forgedEverything, "none")).toBe(UNATTRIBUTED_SOURCE);
  });

  it("believes only cf-connecting-ip behind Cloudflare", () => {
    expect(clientIp(forgedEverything, "cloudflare")).toBe("203.0.113.7");
    // x-forwarded-for is not consulted, even though it is present.
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.1" }), "cloudflare"))
      .toBe(UNATTRIBUTED_SOURCE);
  });

  it("believes only x-forwarded-for behind a trusted proxy", () => {
    expect(clientIp(forgedEverything, "forwarded")).toBe("198.51.100.1");
    // A client-supplied cf-connecting-ip must not win behind a plain proxy.
    expect(clientIp(headers({ "cf-connecting-ip": "203.0.113.7" }), "forwarded"))
      .toBe(UNATTRIBUTED_SOURCE);
  });

  it("takes the leftmost forwarded entry", () => {
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.4, 10.0.0.5" }), "forwarded"))
      .toBe("198.51.100.1");
  });

  it("treats a blank header as absent", () => {
    expect(clientIp(headers({ "cf-connecting-ip": "   " }), "cloudflare")).toBe(UNATTRIBUTED_SOURCE);
    expect(clientIp(headers({ "x-forwarded-for": " , 10.0.0.4" }), "forwarded")).toBe(UNATTRIBUTED_SOURCE);
  });

  it("falls back to a shared bucket rather than a unique key", () => {
    // Sharing one bucket over-throttles; a unique key would silently disable
    // source limiting altogether. A security control should fail closed.
    for (const front of ["cloudflare", "forwarded", "none"] as const) {
      expect(clientIp(headers({}), front)).toBe(UNATTRIBUTED_SOURCE);
    }
  });
});

describe("requestSource", () => {
  it("trusts nothing until the environment declares a front", () => {
    expect(requestSource({ env: {}, req: forgedEverything })).toBe(UNATTRIBUTED_SOURCE);
    expect(requestSource({ env: { CLIENT_IP_SOURCE: "none" }, req: forgedEverything })).toBe(UNATTRIBUTED_SOURCE);
    expect(requestSource({ env: { CLIENT_IP_SOURCE: "yes" }, req: forgedEverything })).toBe(UNATTRIBUTED_SOURCE);
  });

  it("applies the declared front", () => {
    expect(requestSource({ env: { CLIENT_IP_SOURCE: "cloudflare" }, req: forgedEverything })).toBe("203.0.113.7");
    expect(requestSource({ env: { CLIENT_IP_SOURCE: "forwarded" }, req: forgedEverything })).toBe("198.51.100.1");
  });
});
