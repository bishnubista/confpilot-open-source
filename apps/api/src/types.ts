import type { Database } from "./runtime/database";
import type { PrivateFileStore } from "./runtime/private-file-store";
import type { EmailBinding } from "./runtime/email-sender";
import type { RateLimiter } from "./runtime/rate-limiter";

export interface Env {
  DB: Database;
  FILES: PrivateFileStore;
  LOGIN_SOURCE_RATE_LIMITER: RateLimiter;
  LOGIN_ACCOUNT_RATE_LIMITER: RateLimiter;
  /**
   * What sits in front of this deployment: `cloudflare`, `forwarded`, or `none`.
   *
   * Decides which header may be believed when attributing a caller for rate
   * limiting. Every candidate header is client-settable — `cf-connecting-ip` is
   * only trustworthy because Cloudflare's edge overwrites it, which is a property
   * of the deployment rather than the header. Anything unrecognised or absent
   * means trust nothing, so a misconfigured host over-throttles instead of
   * accepting a forged identity. See `runtime/client-ip.ts`.
   */
  CLIENT_IP_SOURCE?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
  CALENDAR_UID_DOMAIN?: string;
  EMAIL?: EmailBinding;
  EMAIL_DELIVERY_ENABLED?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_DELIVERY_SEND_AFTER?: string;
  /**
   * Where the source for *this* instance can be obtained.
   *
   * AGPL section 13 requires a network service to offer the corresponding source
   * of the version it is actually running, so the upstream default is only
   * correct for an unmodified deployment. A modified instance must point this at
   * its own repository or revision; leaving it on upstream offers users source
   * that is not what they are using.
   */
  SOURCE_URL?: string;
}

export interface Variables {
  requestId: string;
  authUserId: string;
  authEventId: string;
  authRole: EventRole;
}

export type EventRole = "organizer" | "reviewer" | "speaker";

export type AppBindings = { Bindings: Env; Variables: Variables };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    issues?: Array<{ field: string; message: string }>;
  };
}
