/**
 * The site's response header policy, in one place.
 *
 * These headers currently exist only in `apps/web/public/_headers`, which is a
 * Cloudflare-specific file format. That is a hosting trap: `wrangler.jsonc` sets
 * `run_worker_first` to just `/api`, `/api/*`, and `/llms.txt`, so SPA and static
 * routes never reach the Worker at all. Serve this app from nginx, Caddy, or Node
 * and every one of these protections silently disappears — no error, no failing
 * test, because nothing outside Cloudflare ever reads that file.
 *
 * The tempting fix is to move the policy into Worker middleware. That is wrong in
 * both directions: on Cloudflare it would *delete* the headers from exactly the
 * pages that need them, and a single middleware cannot express a policy that
 * differs per route — which this one does, load-bearingly.
 *
 * So the policy lives here, and `_headers` is generated from it. Cloudflare keeps
 * reading the generated file; a Node host calls `headersForPath` and gets the same
 * answer. `test/static-headers.test.mjs` fails if the committed file drifts from
 * what this module renders.
 *
 * The route-specific part is not decoration. Authenticated surfaces deny framing;
 * public embed routes deliberately do not, because organizers embed their program
 * in their own sites. `test/worker-config.test.mjs` pins both halves of that.
 */

/** Applied to every path. */
export const BASE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
  ["Strict-Transport-Security", "max-age=31536000"],
  [
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // Turnstile injects its widget from this origin and calls back to it.
      "script-src 'self' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://challenges.cloudflare.com",
      "frame-src 'self' https://challenges.cloudflare.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  ],
];

/**
 * Routes that must never be framed.
 *
 * Anything behind a session, anything that accepts credentials, and anything
 * that consumes a single-use token. Deliberately absent: `/embed/*` and
 * `/events/:event/embed/*`, which exist to be framed by third parties — a
 * blanket frame denial would break every published embed.
 *
 * Keep this in step with the routes `apps/web/src/App.tsx` actually serves. Three
 * surfaces were unprotected until this policy was extracted and the list became
 * explicit enough to audit against the router.
 */
export const FRAME_DENIED_ROUTES: readonly string[] = [
  "/admin",
  "/admin/*",
  "/events/:event/admin",
  "/events/:event/admin/*",
  "/submit",
  "/events/:event/submit",
  // `App.tsx` also serves /events/:event/submit/:proposalId, the proposal-detail
  // form. Without this it inherited only the base policy and stayed framable.
  "/events/:event/submit/*",
  "/reviewer",
  "/reviewer/*",
  "/events/:event/reviewer",
  "/events/:event/reviewer/*",
  "/speaker-portal",
  "/events/:event/speaker",
  // The speaker workspace is the only one with no detail segment, so it was the
  // only one without a `/*` sibling — and a trailing slash falls outside an
  // anchored pattern. `/events/:event/speaker/` matches the SPA router with an
  // empty detail, which is falsy, so App.tsx renders the authenticated portal at
  // a URL this policy did not cover. Every other workspace was already protected
  // by its own `/*` entry, which matches the empty remainder after the slash.
  "/events/:event/speaker/*",
  // Single-use token flows that create an account and set a session. Framing
  // these is exactly the clickjacking case worth denying.
  "/reviewer-invitation",
  "/speaker-claim",
];

export const FRAME_DENIED_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Content-Security-Policy", "frame-ancestors 'none'"],
  ["X-Frame-Options", "DENY"],
];

export const IMMUTABLE_ASSET_ROUTE = "/assets/*";
export const IMMUTABLE_ASSET_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Cache-Control", "public, max-age=31536000, immutable"],
];

/** Rationale carried into the generated file, where an operator reading it will look. */
const IMMUTABLE_ASSET_NOTE = `Vite emits /assets/* with a content hash in every filename, so a URL there is
permanently 1:1 with its bytes and can be cached indefinitely. Without this,
every repeat visit revalidates each script and stylesheet before the page can
render; with it, a returning visitor makes no asset request at all.

The SPA fallback does return index.html with a 200 for an asset URL that no
longer exists, but that is not an argument against this rule: it already
happens under the must-revalidate default, and X-Content-Type-Options above
means a browser refuses to execute an HTML body as a module script. It fails
visibly rather than being cached as JavaScript. index.html itself deliberately
has no rule here, so it keeps must-revalidate and picks up deploys immediately.

Do not widen this to /*. The guarantee comes from the content hash, which only
files under /assets/ have.`;

export interface HeaderRule {
  pattern: string;
  headers: ReadonlyArray<readonly [string, string]>;
  note?: string;
}

/** The policy as ordered rules. Order matters: later rules append to earlier ones. */
export const HEADER_RULES: readonly HeaderRule[] = [
  { pattern: "/*", headers: BASE_HEADERS },
  ...FRAME_DENIED_ROUTES.map((pattern) => ({ pattern, headers: FRAME_DENIED_HEADERS })),
  { pattern: IMMUTABLE_ASSET_ROUTE, headers: IMMUTABLE_ASSET_HEADERS, note: IMMUTABLE_ASSET_NOTE },
];

/**
 * Match a `_headers` route pattern against a path.
 *
 * `:name` matches one segment, `*` matches any suffix — the same semantics
 * Cloudflare applies, so a Node host resolves a request identically.
 */
function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[a-zA-Z][a-zA-Z0-9_]*/g, "[^/]+")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${source}$`);
}

/**
 * Resolve the headers for a path.
 *
 * Every matching rule contributes, in order. A header named by more than one rule
 * is comma-joined rather than replaced — which is how `/admin` ends up with the
 * base CSP *and* `frame-ancestors 'none'`, rather than losing one of them.
 *
 * Pass a pathname, not a URL: patterns are anchored, so `/submit?token=x` would
 * match nothing and silently return the base policy for a frame-denied route.
 * A caller holding a request URL should pass `new URL(request.url).pathname`.
 */
export function headersForPath(path: string): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const rule of HEADER_RULES) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      const existing = resolved.get(key);
      resolved.set(key, existing ? `${existing}, ${value}` : value);
    }
  }
  return resolved;
}

const GENERATED_BANNER = `# Generated from apps/api/src/runtime/security-headers.ts.
# Do not edit by hand — run \`pnpm --filter @confpilot/api headers:generate\`.
#
# Cloudflare is the only host that reads this file. A Node or container host
# resolves the same policy through headersForPath(), and \`pnpm check\` fails if
# the two ever disagree.`;

/** Render the Cloudflare `_headers` file. Compared byte-for-byte against the committed copy. */
export function renderStaticHeadersFile(): string {
  const blocks = HEADER_RULES.map((rule) => {
    const comment = rule.note ? `${rule.note.split("\n").map((line) => (line ? `# ${line}` : "#")).join("\n")}\n` : "";
    const headers = rule.headers.map(([name, value]) => `  ${name}: ${value}`).join("\n");
    return `${comment}${rule.pattern}\n${headers}`;
  });
  return `${[GENERATED_BANNER, ...blocks].join("\n\n")}\n`;
}
