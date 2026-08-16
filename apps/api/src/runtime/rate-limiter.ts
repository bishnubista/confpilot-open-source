/**
 * Request rate limiting, as a port.
 *
 * Login, registration, and the token-claim flows throttle by source address and
 * by account before touching credentials. That happens through two Cloudflare
 * `RateLimit` bindings reached directly from `env`, which is the last binding
 * besides the database that feature code names by its platform type.
 *
 * The port is deliberately the same shape Cloudflare exposes, so the existing
 * bindings satisfy it structurally and no call site changes behaviour. What it
 * buys is that a non-Cloudflare host has somewhere to plug in.
 *
 * One property matters more than the interface: **limiter state must be shared
 * across every process serving the app**. Cloudflare's binding is shared by
 * construction. A naive in-memory implementation is not — run two Node processes
 * behind a load balancer and each gets its own counter, quietly multiplying the
 * login attempt budget by the number of workers. That is why no in-memory
 * implementation ships here beyond the explicitly-permissive one below; the Node
 * host gets a shared, durable limiter alongside its own storage.
 */

export interface RateLimitOutcome {
  success: boolean;
}

/**
 * The login throttles, stated once so both hosts enforce the same numbers.
 *
 * `wrangler.jsonc` declares them for Cloudflare's binding and the Node host
 * builds its limiters from them, which is two copies of a security parameter
 * unless something holds them together — so `test/worker-config.test.mjs` fails
 * if the two disagree. A throttle that is stricter on one host than the other is
 * not a portability detail; it is a different security posture per deployment.
 */
export const LOGIN_RATE_LIMITS = {
  source: { binding: "LOGIN_SOURCE_RATE_LIMITER", limit: 20, periodSeconds: 60 },
  account: { binding: "LOGIN_ACCOUNT_RATE_LIMITER", limit: 5, periodSeconds: 60 },
} as const;

export interface RateLimiter {
  limit(options: { key: string }): Promise<RateLimitOutcome>;
}

/**
 * A limiter that permits everything.
 *
 * For tests, and for a local single-user instance where throttling adds nothing.
 * Named for what it does rather than "noop", because wiring this into a
 * production instance removes brute-force protection and the call site should
 * read that way.
 */
export function createAllowAllRateLimiter(): RateLimiter {
  return { limit: async () => ({ success: true }) };
}
