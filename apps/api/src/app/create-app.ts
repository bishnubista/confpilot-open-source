import { Hono, type MiddlewareHandler } from "hono";

import { errorResponse } from "../http";
import { requireSameOriginMutation } from "../request-safety";
import type { AppBindings } from "../types";
import { featureManifest } from "./feature-manifest";

export const responseSecurityHeaders: MiddlewareHandler<AppBindings> = async (context, next) => {
  const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
  context.set("requestId", requestId);
  await next();

  context.res.headers.set("x-request-id", requestId);
  context.res.headers.set("x-content-type-options", "nosniff");
  context.res.headers.set("strict-transport-security", "max-age=31536000");
  if (!context.res.headers.has("cache-control")) {
    context.res.headers.set("cache-control", "private, no-store");
  }
};

/**
 * Compose the API from the feature manifest.
 *
 * Two invariants hold for every request before any feature code runs: a request
 * id and the response security headers are attached, and every `/api` mutation
 * passes the same-origin check. Registering those here rather than per feature
 * means a new module cannot forget them.
 */
export function createApp() {
  const app = new Hono<AppBindings>();

  app.use("*", responseSecurityHeaders);
  app.use("/api/*", requireSameOriginMutation);

  for (const feature of featureManifest) {
    app.route(feature.basePath, feature.createRoutes());
  }

  app.notFound((context) =>
    errorResponse(context, 404, "NOT_FOUND", "The requested API route does not exist."),
  );

  app.onError((error, context) => {
    console.error("Unhandled API error", { requestId: context.get("requestId"), error });
    return errorResponse(context, 500, "INTERNAL_ERROR", "The request could not be completed.");
  });

  return app;
}
