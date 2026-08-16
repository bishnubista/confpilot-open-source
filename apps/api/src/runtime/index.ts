/**
 * External capabilities ConfPilot depends on.
 *
 * Everything else in the API is portable TypeScript over D1 SQL. These are the
 * only places a different host needs an adapter, which is why they are named as
 * ports instead of being reached for through `env` at each call site.
 *
 * There is deliberately no app-level `AppRuntime` aggregate. In Workers, `env`
 * is only available per request, so a runtime assembled at module initialisation
 * would either capture nothing or capture the wrong request's bindings. Each
 * port is therefore resolved per request at its point of use.
 *
 * The database is a port too, as of the hosting work. It was previously left as
 * a raw `D1Database` binding on the grounds that it had no second
 * implementation; that stopped being true once running off Cloudflare became a
 * goal. `Database` is satisfied structurally by D1, so the binding still
 * type-checks unchanged, and `sqlite-database.ts` provides the second
 * implementation. That adapter is deliberately *not* re-exported here: it pulls
 * in a native module that cannot be bundled for workerd, so a Node entry point
 * imports it directly instead.
 *
 * Rate limiting still stays on its `env` binding: it remains a request-scoped
 * Cloudflare primitive with no second implementation today, so a port would add
 * indirection without adding portability. That changes when a Node host needs
 * shared-state limiting.
 */
export type {
  Database,
  DatabaseMeta,
  DatabaseResult,
  DatabaseStatement,
} from "./database";
export { constraintMessage, MAX_BOUND_PARAMETERS } from "./database";

export type { ClientIpSource, HeaderSource } from "./client-ip";
export { clientIp, requestSource, resolveClientIpSource, UNATTRIBUTED_SOURCE } from "./client-ip";

export type { RateLimiter, RateLimitOutcome } from "./rate-limiter";
export { createAllowAllRateLimiter } from "./rate-limiter";

export type {
  CaptchaPublicConfig,
  CaptchaResult,
  CaptchaVerifier,
} from "./captcha-verifier";
export { createDisabledCaptchaVerifier, createTurnstileCaptchaVerifier } from "./captcha-verifier";

export type { EmailCapability, EmailDeliveryRuntime, EmailResult, EmailSender, OutboundEmail } from "./email-sender";
export { createDisabledEmailSender } from "./email-sender";
export type { CloudflareEmailSenderConfig } from "./cloudflare-email-sender";
export { createCloudflareEmailSender } from "./cloudflare-email-sender";
export type { EmailRuntimeEnvironment } from "./email-delivery-runtime";
export { resolveEmailDeliveryRuntime } from "./email-delivery-runtime";

export type { PrivateFileStore } from "./private-file-store";
export { createR2PrivateFileStore } from "./private-file-store";
