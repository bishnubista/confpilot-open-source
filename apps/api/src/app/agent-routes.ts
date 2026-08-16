import { Hono } from "hono";

import { SESSION_COOKIE } from "../auth";
import { SESSION_SECONDS } from "../auth-routes";
import type { AppBindings } from "../types";
import {
  AGENT_MANIFEST_VERSION,
  agentBoundaries,
  agentOperations,
  mutationPreamble,
  retryModeDescriptions,
} from "./agent-manifest";
import { sourceUrl } from "./source-offer";

/**
 * Machine-readable description of how to *operate* this instance.
 *
 * `/llms.txt` covers anonymous reading. This covers the authenticated surface:
 * how to obtain a session, the preamble every mutation must carry, and every
 * operation with the role it needs, whether a repeat is safe, and whether a
 * human should confirm it first.
 *
 * The document is structural, not instance data. It names no event, exposes no
 * counts, and reads nothing from the database, so it is safe to serve
 * anonymously and to cache publicly. An agent needs it *before* it can sign in,
 * which is exactly why it cannot be behind authentication.
 */
export function createAgentRoutes() {
  const routes = new Hono<AppBindings>();

  routes.get("/agent/manifest", (context) => {
    const publishedSourceUrl = sourceUrl(context.env.SOURCE_URL);
    if (!publishedSourceUrl) {
      return context.json(
        {
          error: {
            code: "SOURCE_URL_INVALID",
            message: "ConfPilot cannot publish its agent manifest because SOURCE_URL is invalid.",
            requestId: context.get("requestId"),
          },
        },
        503,
        { "cache-control": "private, no-store" },
      );
    }

    const origin = new URL(context.req.url).origin;

    return context.json(
      {
        confpilotAgentManifest: AGENT_MANIFEST_VERSION,
        instance: {
          origin,
          software: "ConfPilot",
          license: "AGPL-3.0-or-later",
          source: publishedSourceUrl,
          anonymousIndex: `${origin}/llms.txt`,
        },
        authentication: {
          kind: "session-cookie",
          cookie: `__Host-${SESSION_COOKIE}`,
          lifetimeSeconds: SESSION_SECONDS,
          signIn: {
            operation: "identity.signIn",
            body: ["email", "password"],
            note: "The response sets the session cookie. Persist and resend it on every subsequent request.",
          },
          whoami: { operation: "identity.session" },
          signOut: { operation: "identity.signOut" },
          note: "Roles are granted per event. One account may hold different roles on different events; check memberships from identity.session.",
        },
        mutationPreamble: mutationPreamble(origin),
        retryModes: retryModeDescriptions,
        boundaries: agentBoundaries,
        operations: agentOperations,
      },
      200,
      { "cache-control": "public, max-age=300" },
    );
  });

  return routes;
}
