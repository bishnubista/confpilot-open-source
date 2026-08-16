/**
 * The AGPL section 13 source offer this instance publishes.
 *
 * Both machine-readable surfaces — `/llms.txt` and the agent manifest — have to
 * answer the same question, and both must fail closed rather than publish a
 * non-web scheme or leak URL userinfo. Resolving it in one place keeps the two
 * documents from disagreeing about where this instance's source can be obtained.
 */

export const UPSTREAM_SOURCE_URL = "https://github.com/bishnubista/confpilot-open-source";

/**
 * Resolve the published source URL, or `null` when the operator misconfigured it.
 *
 * An operator running a modified ConfPilot must set `SOURCE_URL` to their own
 * published source. Only http(s) without embedded credentials is accepted.
 */
export function sourceUrl(configured: string | undefined) {
  const value = configured?.trim();
  if (!value) return UPSTREAM_SOURCE_URL;
  try {
    const url = new URL(value);
    const isHttp = url.protocol === "https:" || url.protocol === "http:";
    return isHttp && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
