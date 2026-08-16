import { afterEach, describe, expect, it, vi } from "vitest";

import { publicTurnstileConfig, verifyRegistrationTurnstile } from "../src/turnstile";
import type { Env } from "../src/types";

const env = {
  TURNSTILE_SITE_KEY: "public-test-site-key",
  TURNSTILE_SECRET_KEY: "private-test-secret-key",
  TURNSTILE_ALLOWED_HOSTNAMES: "example.com, preview.example.com",
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe("Turnstile registration verification", () => {
  it("sends the token only to Siteverify and validates its action and hostname", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: "speaker_registration",
      hostname: "preview.example.com",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRegistrationTurnstile(env, "short-lived-token", "192.0.2.10", "preview.example.com")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = request.body as FormData;
    expect(body.get("secret")).toBe("private-test-secret-key");
    expect(body.get("response")).toBe("short-lived-token");
    expect(body.get("remoteip")).toBe("192.0.2.10");
    expect(body.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fails closed for mismatched claims, provider errors, or incomplete configuration", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, action: "login", hostname: "example.com" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRegistrationTurnstile(env, "wrong-action", undefined, "example.com")).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(verifyRegistrationTurnstile(env, "provider-error", undefined, "example.com")).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(verifyRegistrationTurnstile({} as never, "no-config", undefined, "example.com")).resolves.toEqual({ ok: false, reason: "unconfigured" });
    expect(publicTurnstileConfig({} as never, "example.com")).toEqual({ enabled: false, siteKey: null });
  });

  it("rejects a token issued for a different configured hostname", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      action: "speaker_registration",
      hostname: "preview.example.com",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRegistrationTurnstile(env, "cross-host-token", undefined, "example.com"))
      .resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("accepts Cloudflare's documented test action only with the published dummy secret", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      success: true,
      hostname: "example.com",
    }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyRegistrationTurnstile({
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      TURNSTILE_ALLOWED_HOSTNAMES: "localhost",
    } as never, "XXXX.DUMMY.TOKEN.XXXX", undefined, "localhost")).resolves.toEqual({ ok: true });
    await expect(verifyRegistrationTurnstile({
      ...env,
      TURNSTILE_ALLOWED_HOSTNAMES: "localhost",
    } as never, "test-action-with-real-secret", undefined, "localhost")).resolves.toEqual({ ok: false, reason: "invalid" });
    const unsafeTestEnv = {
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      TURNSTILE_ALLOWED_HOSTNAMES: "preview.example.com",
    } as never;
    await expect(verifyRegistrationTurnstile(unsafeTestEnv, "dummy-token", undefined, "preview.example.com")).resolves.toEqual({ ok: false, reason: "unconfigured" });
    expect(publicTurnstileConfig(unsafeTestEnv, "preview.example.com")).toEqual({ enabled: false, siteKey: null });
  });

  it("never enables published dummy credentials on a non-local request host", async () => {
    const localTestEnv = {
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      TURNSTILE_ALLOWED_HOSTNAMES: "localhost",
    } as never;
    expect(publicTurnstileConfig(localTestEnv, "preview.example.com")).toEqual({ enabled: false, siteKey: null });
    await expect(verifyRegistrationTurnstile(localTestEnv, "garbage", undefined, "preview.example.com"))
      .resolves.toEqual({ ok: false, reason: "unconfigured" });
  });
});
