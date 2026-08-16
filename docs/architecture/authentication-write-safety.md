# Authentication and write-safety foundation

Status: accepted for the first credential-authenticated ConfPilot feature slice on 2026-08-11.

## Decision

ConfPilot will issue opaque server sessions before exposing CFP, review, decision, or speaker-task mutations. HTTP contracts use Zod; ordered SQL migrations remain the sole D1 schema authority. Wire schemas intentionally do not mirror database tables.

The current implementation includes credential verification, public speaker registration protected by Cloudflare Turnstile, and opaque server sessions. It does not add account recovery, email delivery, OAuth, magic links, or reusable demo credentials.

## Password storage

- Passwords are derived with PBKDF2-HMAC-SHA256 using 100,000 iterations, a unique 16-byte salt, and a 32-byte result.
- D1 stores the algorithm, iteration count, hexadecimal salt, and hexadecimal derived value in `user_credentials`; plaintext passwords are never stored or logged.
- Unknown emails still perform the same PBKDF2 work and return the same response as an incorrect password.
- Password input is bounded to 128 characters before expensive work.
- New credentials use exactly 100,000 iterations, the maximum accepted by the deployed Workers Web Crypto runtime. The compatibility migration preserves existing 600,000-iteration rows without invoking that unsupported work factor; those rows fail closed until they are rotated. Login never accepts an arbitrary row-selected work factor, preventing a corrupt row from becoming a CPU amplifier or timing oracle.
- Login accepts any non-empty password up to 128 characters; password-creation policy is intentionally not exposed through the authentication response.
- This release accepts ASCII email addresses only so Worker and SQLite normalization semantics cannot diverge.

The 100,000-iteration factor is a platform-compatibility compromise below the current [OWASP Password Storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Cloudflare documents PBKDF2 as available through [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), while the deployed runtime rejects iteration counts above 100,000. Source and account rate limits therefore remain mandatory, and password credentials are a preview bridge rather than the desired long-term identity design. Google sign-in and Cloudflare's [magic-link email pattern](https://developers.cloudflare.com/email-service/examples/email-sending/magic-link/) remain the post-competition replacement once provider credentials, account linking, and recovery are designed.

## Session contract

- Successful login generates 32 random bytes and exposes them only as a `__Host-confpilot_session` cookie.
- The cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Priority=High`, and expires after seven days. ConfPilot has no external sign-in redirect that requires cross-site cookie delivery.
- D1 stores only the token's SHA-256 digest.
- Logging in rotates the session presented by the current browser without silently signing out other devices.
- Logout revokes the presented server session and clears the cookie. Expired and revoked sessions cannot authorize event routes.
- Session responses contain the canonical user and event memberships; they never contain a credential or token.

The `__Host-` prefix is enforced through Hono's [cookie helper](https://hono.dev/docs/helpers/cookie), which requires Secure, root Path, and no Domain attribute.

## Mutation protection

Every unsafe `/api/*` request is rejected before route handling unless:

1. `Origin` exactly equals the request URL's origin;
2. `Sec-Fetch-Site`, when present, is `same-origin`; and
3. `X-ConfPilot-Request: 1` is present.

Missing, opaque, same-site, and cross-site origins fail closed. This covers login CSRF, logout, unknown future mutations, and subsequent CFP routes. The custom header also prevents a cross-site HTML form from producing an accepted simple request. This follows the current [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Abuse control

Login uses two Cloudflare native [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) before D1 credential lookup or PBKDF2:

- a source budget of 20 attempts per 60 seconds, keyed by a SHA-256 digest of Cloudflare's `CF-Connecting-IP`; and
- an account budget of five attempts per 60 seconds, keyed by a SHA-256 digest of the normalized email.

The source budget runs before JSON parsing, preventing an attacker from rotating account identifiers to force unbounded PBKDF2 work. The account budget slows targeted guessing. Raw IP and email values are not logged or passed as limiter keys.

Cloudflare discourages using IP addresses as a general user identity because many legitimate users can share one address. ConfPilot uses a relatively generous source budget only as a CPU-cost circuit breaker, not as its user-level policy. Public account creation requires a server-verified Turnstile token with the expected action and hostname before any credential work or database write. Sign-in remains protected by the two Worker rate-limit bindings. An Application Security rate-limiting rule with Managed Challenge remains optional production defense in depth, as recommended by Cloudflare's [account takeover guide](https://developers.cloudflare.com/use-cases/solutions/stop-account-takeover-attacks/).

The bindings are per-location and eventually consistent. They are defense against obvious abuse, not accounting or exact lockout systems. Both namespace IDs must be checked for uniqueness across the Cloudflare account before the first remote deploy.

Both limiter failures return `429` with `Retry-After: 60`. The account budget intentionally counts every validly shaped attempt, including successful ones; its purpose is a bounded attempt budget, not failure-only accounting.

## D1 and deployment gates

- `0000_initial.sql` remains immutable; credentials arrive through forward migration `0001_auth_credentials.sql`.
- Run the read-only `preflight/preflight_auth_credentials.sql` query before migration. Any normalized-email collision is a no-go requiring an explicit identity merge decision; the migration must fail closed rather than guess which user owns access.
- Migrations are tested against SQLite and the D1-compatible Miniflare runtime before remote application.
- No credential rows are included in the demo seed.
- Production provisioning must create credentials through an approval-gated, one-time operational path; never by committing a password or derived fixture.
- Before remote migration or deploy: refresh Cloudflare identity/inventory, verify both rate-limit namespaces, choose a CPU-compatible plan, configure Turnstile hostnames and keys, run the email-collision preflight, capture a D1 Time Travel bookmark, run the privacy scan, and obtain explicit approval for each external mutation.

## Deferred decisions

- Google sign-in and email magic links are deferred until after the competition release; they require a separate account-linking and recovery design.
- Multiple roles for the same user within one event will be introduced only when a verified workflow requires it.
- Password reset, email verification, MFA, and managed identity are post-evaluation features unless the challenge requires them.
- Reviewer account/credential provisioning and outbound communication remain separate from assignment persistence. Once an organizer assigns an existing reviewer account, the reviewer must explicitly accept or decline that in-app assignment invitation before scoring; this does not send email or create credentials.
- Real notification delivery remains separate from recorded decisions and the D1 outbox.
