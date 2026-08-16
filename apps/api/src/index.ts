/**
 * Worker entry point.
 *
 * Composition lives in `app/create-app.ts` and the lifecycle modules it mounts
 * are declared in `app/feature-manifest.ts`. External capabilities are declared
 * as ports in `runtime/`. Start with the manifest to find the code for a
 * feature.
 */
export { createApp, responseSecurityHeaders } from "./app/create-app";

import { createApp } from "./app/create-app";
import { runScheduledEmailDispatch } from "./app/email-dispatch";
import type { Env } from "./types";

const app = createApp();

export default {
  fetch(request, environment, context) {
    return app.fetch(request, environment, context);
  },
  scheduled(controller, environment, context) {
    context.waitUntil(runScheduledEmailDispatch(environment, controller.scheduledTime).catch((error: unknown) => {
      // Do not log provider messages or recipient-bearing errors.
      console.error("Scheduled email dispatch failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }));
  },
} satisfies ExportedHandler<Env>;
