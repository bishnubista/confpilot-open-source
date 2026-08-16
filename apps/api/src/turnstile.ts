import type { Env } from "./types";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;
const REGISTRATION_ACTION = "speaker_registration";
const CLOUDFLARE_ALWAYS_PASS_TEST_SITEKEY = "1x00000000000000000000AA";
const CLOUDFLARE_ALWAYS_PASS_TEST_SECRET = "1x0000000000000000000000000000000AA";
const LOCAL_TEST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
}

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unavailable" | "unconfigured" };

function configuredHostnames(env: Env) {
  return new Set(
    (env.TURNSTILE_ALLOWED_HOSTNAMES ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isSafeLocalTestConfiguration(siteKey: string, secretKey: string, hostnames: Set<string>) {
  return siteKey === CLOUDFLARE_ALWAYS_PASS_TEST_SITEKEY
    && secretKey === CLOUDFLARE_ALWAYS_PASS_TEST_SECRET
    && hostnames.size > 0
    && [...hostnames].every((hostname) => LOCAL_TEST_HOSTNAMES.has(hostname));
}

function hasPublishedTestCredential(siteKey: string, secretKey: string) {
  return siteKey === CLOUDFLARE_ALWAYS_PASS_TEST_SITEKEY
    || secretKey === CLOUDFLARE_ALWAYS_PASS_TEST_SECRET;
}

export function publicTurnstileConfig(env: Env, requestHostname: string) {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  const hostnames = configuredHostnames(env);
  const hostname = requestHostname.trim().toLowerCase();
  const safeTestConfiguration = siteKey && secretKey
    ? isSafeLocalTestConfiguration(siteKey, secretKey, hostnames)
      && LOCAL_TEST_HOSTNAMES.has(hostname)
    : false;
  return siteKey && secretKey && hostnames.has(hostname)
    && (!hasPublishedTestCredential(siteKey, secretKey) || safeTestConfiguration)
    ? { enabled: true as const, siteKey }
    : { enabled: false as const, siteKey: null };
}

export async function verifyRegistrationTurnstile(
  env: Env,
  token: string,
  remoteIp?: string,
  requestHostname?: string,
): Promise<TurnstileResult> {
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const allowedHostnames = configuredHostnames(env);
  const hostname = requestHostname?.trim().toLowerCase();
  if (!secretKey || !siteKey || !hostname || !allowedHostnames.has(hostname)) {
    return { ok: false, reason: "unconfigured" };
  }
  const safeLocalTestConfiguration = isSafeLocalTestConfiguration(siteKey, secretKey, allowedHostnames)
    && LOCAL_TEST_HOSTNAMES.has(hostname);
  if (hasPublishedTestCredential(siteKey, secretKey) && !safeLocalTestConfiguration) {
    return { ok: false, reason: "unconfigured" };
  }

  const body = new FormData();
  body.set("secret", secretKey);
  body.set("response", token);
  body.set("idempotency_key", crypto.randomUUID());
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "unavailable" };
    // `json<T>()` is a Cloudflare extension; the standard method takes no type
    // argument, and the app has to compile for a Node host too. Equally
    // unchecked either way — the assertion is now just visible.
    const result = await response.json() as SiteverifyResponse;
    if (safeLocalTestConfiguration) {
      return result.success === true
        ? { ok: true }
        : { ok: false, reason: "invalid" };
    }
    const verifiedHostname = result.hostname?.trim().toLowerCase();
    if (
      result.success !== true
      || result.action !== REGISTRATION_ACTION
      || !verifiedHostname
      || verifiedHostname !== hostname
    ) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
