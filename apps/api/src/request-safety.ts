import type { MiddlewareHandler } from "hono";

import { errorResponse } from "./http";
import type { AppBindings } from "./types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type BoundedRequestBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "invalid-content-length" | "too-large" };

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedRequestBody> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    return { ok: false, reason: "invalid-content-length" };
  }
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    return { ok: false, reason: "too-large" };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array() };

  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too-large" };
    }
    bytes.set(value, total);
    total += value.byteLength;
  }
  return { ok: true, bytes: bytes.subarray(0, total) };
}

export const requireSameOriginMutation: MiddlewareHandler<AppBindings> = async (context, next) => {
  if (SAFE_METHODS.has(context.req.method)) {
    await next();
    return;
  }

  context.header("vary", "Origin, Sec-Fetch-Site", { append: true });
  const expectedOrigin = new URL(context.req.url).origin;
  const origin = context.req.header("origin");
  const fetchSite = context.req.header("sec-fetch-site");
  const requestMarker = context.req.header("x-confpilot-request");

  if (
    origin !== expectedOrigin
    || (fetchSite !== undefined && fetchSite !== "same-origin")
    || requestMarker !== "1"
  ) {
    return errorResponse(
      context,
      403,
      "UNSAFE_REQUEST_REJECTED",
      "This request could not be verified as same-origin.",
    );
  }

  await next();
};
