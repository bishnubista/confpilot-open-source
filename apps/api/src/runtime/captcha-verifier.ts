import {
  publicTurnstileConfig,
  verifyRegistrationTurnstile,
  type TurnstileResult,
} from "../turnstile";
import type { Env } from "../types";

/**
 * Narrow port for public-registration bot defence.
 *
 * Only public speaker registration is gated. Existing-user sign-in never
 * depends on this port, so an operator who cannot run a captcha provider can
 * still operate an invite-only instance.
 */
export type CaptchaResult = TurnstileResult;

/**
 * Kept as a discriminated union rather than `{ enabled: boolean; siteKey: string | null }`
 * so a disabled verifier cannot type-check its way into exposing a site key.
 */
export type CaptchaPublicConfig =
  | { enabled: true; siteKey: string }
  | { enabled: false; siteKey: null };

export interface CaptchaVerifier {
  /** Configuration the public CFP page needs in order to render a challenge. */
  publicConfig(requestHostname: string): CaptchaPublicConfig;
  /** Verify a challenge response. Implementations must fail closed. */
  verify(
    token: string,
    options: { remoteIp?: string; requestHostname?: string },
  ): Promise<CaptchaResult>;
}

/** Cloudflare Turnstile, verified server-side against Siteverify. */
export function createTurnstileCaptchaVerifier(env: Env): CaptchaVerifier {
  return {
    publicConfig(requestHostname) {
      return publicTurnstileConfig(env, requestHostname);
    },
    verify(token, options) {
      return verifyRegistrationTurnstile(
        env,
        token,
        options.remoteIp,
        options.requestHostname,
      );
    },
  };
}

/**
 * Fail-closed verifier for instances with no captcha provider configured.
 *
 * Reporting `unconfigured` disables public account creation rather than
 * silently allowing unverified registration. This mirrors the behaviour of a
 * partially configured Turnstile widget.
 */
export function createDisabledCaptchaVerifier(): CaptchaVerifier {
  return {
    publicConfig() {
      return { enabled: false, siteKey: null };
    },
    async verify() {
      return { ok: false, reason: "unconfigured" };
    },
  };
}
