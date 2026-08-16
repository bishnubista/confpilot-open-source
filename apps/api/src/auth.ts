import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";

import { errorResponse } from "./http";
import type { AppBindings, EventRole } from "./types";

export const SESSION_COOKIE = "confpilot_session";

interface SessionRow {
  userId: string;
  email: string;
  displayName: string;
}

interface MembershipRow {
  eventId: string;
  role: EventRole;
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getAuthenticatedSession(context: Context<AppBindings>) {
  const token = getCookie(context, SESSION_COOKIE, "host");
  if (!token || token.length > 512) return null;

  return context.env.DB.prepare(
    `SELECT
      user.id AS userId,
      lower(trim(user.email)) AS email,
      user.display_name AS displayName
    FROM auth_sessions AS session
    INNER JOIN users AS user ON user.id = session.user_id
    WHERE session.token_hash = ?
      AND unixepoch(session.expires_at) > unixepoch(?)
      AND session.revoked_at IS NULL
    LIMIT 1`,
  ).bind(await hashToken(token), new Date().toISOString()).first<SessionRow>();
}

export function requireEventRole(requiredRole: EventRole): MiddlewareHandler<AppBindings> {
  return async (context, next) => {
    const session = await getAuthenticatedSession(context);
    if (!session) {
      return errorResponse(context, 401, "UNAUTHENTICATED", "Sign in to access this event workspace.");
    }

    const eventSlug = context.req.param("eventSlug");
    if (!eventSlug) {
      return errorResponse(context, 400, "EVENT_REQUIRED", "An event slug is required.");
    }

    const membership = await context.env.DB
      .prepare(
        `SELECT event.id AS eventId, membership.role AS role
        FROM events AS event
        INNER JOIN event_memberships AS membership
          ON membership.event_id = event.id
          AND membership.user_id = ?
        WHERE event.slug = ?
          AND membership.role = ?
        LIMIT 1`,
      )
      .bind(session.userId, eventSlug, requiredRole)
      .first<MembershipRow>();

    if (!membership) {
      return errorResponse(context, 403, "FORBIDDEN", "You do not have access to this event workspace.");
    }

    context.set("authUserId", session.userId);
    context.set("authEventId", membership.eventId);
    context.set("authRole", membership.role);
    await next();
  };
}
