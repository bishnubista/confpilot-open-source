/**
 * Identify the caller's address for rate limiting.
 *
 * Login, registration and the token-claim flows throttle by source address
 * before touching credentials, so whatever this returns is a security control.
 * Getting it wrong is a bug in both directions: trust a forgeable header and an
 * attacker rotates it to bypass throttling entirely; ignore a legitimate one and
 * unrelated users share a bucket.
 *
 * **Every candidate header is client-settable.** `cf-connecting-ip` is safe on
 * Cloudflare only because the edge overwrites whatever the client sent — that
 * property belongs to the deployment, not to the header. Off Cloudflare it is
 * exactly as forgeable as `x-forwarded-for`, so trusting it by default would
 * hand a self-hosted instance a throttling bypass. The same is true in reverse
 * for `x-forwarded-for` behind a proxy that overwrites it.
 *
 * So the question this module answers is not "is this header trustworthy?" but
 * **"what sits in front of this deployment?"** — which has exactly one answer per
 * host, and must be declared rather than guessed. `CLIENT_IP_SOURCE` declares it,
 * and defaults to trusting nothing.
 */

/** Anything that can look up a request header — matches Hono's `context.req`. */
export interface HeaderSource {
  header(name: string): string | undefined;
}

export const UNATTRIBUTED_SOURCE = "unattributed";

/**
 * What sits in front of this deployment, and therefore which header can be believed.
 *
 * - `cloudflare` — behind Cloudflare, which overwrites `cf-connecting-ip`.
 * - `forwarded` — behind a proxy you control that *overwrites* `x-forwarded-for`.
 *   If it merely appends, the leftmost entry is still attacker-controlled and
 *   this setting is unsafe.
 * - `none` — directly exposed, or unknown. Every caller shares one bucket.
 */
export type ClientIpSource = "cloudflare" | "forwarded" | "none";

/**
 * Read the declared front, defaulting to trusting nothing.
 *
 * Fail-closed on purpose: an unrecognised or absent value degrades to a shared
 * bucket, which over-throttles. The alternative default would silently accept a
 * forged header on any host that forgot to configure this.
 */
export function resolveClientIpSource(value: string | undefined): ClientIpSource {
  return value === "cloudflare" || value === "forwarded" ? value : "none";
}

export function clientIp(source: HeaderSource, front: ClientIpSource): string {
  if (front === "cloudflare") {
    const edgeAddress = source.header("cf-connecting-ip")?.trim();
    if (edgeAddress) return edgeAddress;
  }

  if (front === "forwarded") {
    // The leftmost entry is the original client when a trusted proxy rewrites
    // the header; entries to its right are the proxy chain.
    const forwarded = source.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }

  // Shared bucket rather than a per-request key: over-throttling is the safe
  // direction, while a unique key would silently disable source limiting.
  return UNATTRIBUTED_SOURCE;
}

/**
 * Resolve the throttling key for a request, reading the declared front from env.
 *
 * Exists so the five throttled routes share one call rather than each repeating
 * a header name — which is how `cf-connecting-ip` came to be hard-coded in five
 * places, and why changing the trust model would otherwise have been a five-site
 * edit with five chances to miss one.
 */
export function requestSource(context: {
  env: { CLIENT_IP_SOURCE?: string };
  req: HeaderSource;
}): string {
  return clientIp(context.req, resolveClientIpSource(context.env.CLIENT_IP_SOURCE));
}
