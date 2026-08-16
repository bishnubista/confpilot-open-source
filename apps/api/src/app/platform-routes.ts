import {
  organizerEventCreateSchema,
  programReadinessResponseSchema,
  SESSION_FORMAT_DURATIONS,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { getAuthenticatedSession, requireEventRole } from "../auth";
import { sessionProjection } from "../auth-routes";
import { errorResponse } from "../http";
import type { AppBindings } from "../types";
import { getProgramReadiness } from "./program-readiness-service";
import { constraintMessage } from "../runtime/database";

interface PublishedEventRow {
  slug: string;
  name: string;
  tagline: string;
  location: string;
  description: string;
  startsOn: string;
  endsOn: string;
  cfpDeadline: string;
  status: string;
}

function validationIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
}

async function parseEventCreate(context: Context<AppBindings>) {
  let input: unknown;
  try {
    input = await context.req.json();
  } catch {
    return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  const result = organizerEventCreateSchema.safeParse(input);
  if (!result.success) {
    return errorResponse(
      context,
      400,
      "VALIDATION_FAILED",
      "Check the event details and try again.",
      validationIssues(result.error),
    );
  }
  return result.data;
}

/**
 * Instance-level routes that belong to no single lifecycle feature: liveness,
 * organizer-scoped draft event creation, the published event index, and the
 * derived readiness trail.
 *
 * Readiness is computed from the same rows the lifecycle already writes rather
 * than stored as its own workflow state, so it cannot drift from reality.
 */
export function createPlatformRoutes() {
  const routes = new Hono<AppBindings>();

  routes.get("/health", async (context) => {
    let database: { ok: number } | null = null;
    try {
      database = await context.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    } catch (error) {
      console.error("Health check database probe failed", {
        requestId: context.get("requestId"),
        error,
      });
    }

    const healthy = database?.ok === 1;
    return context.json({
      status: healthy ? "ok" : "degraded",
      service: "confpilot-api",
      database: healthy ? "connected" : "unavailable",
      requestId: context.get("requestId"),
    }, healthy ? 200 : 503);
  });

  routes.get("/events", async (context) => {
    const { results: rows } = await context.env.DB
      .prepare(
        `SELECT
          slug,
          name,
          tagline,
          location,
          description,
          starts_on AS startsOn,
          ends_on AS endsOn,
          cfp_deadline AS cfpDeadline,
          status
        FROM events
        WHERE status = 'published'
        ORDER BY starts_on ASC`,
      )
      .all<PublishedEventRow>();

    return context.json({ data: rows, requestId: context.get("requestId") });
  });

  routes.post("/events", async (context) => {
    const session = await getAuthenticatedSession(context);
    if (!session) {
      return errorResponse(context, 401, "UNAUTHENTICATED", "Sign in to create an event.");
    }

    const organizer = await context.env.DB.prepare(
      `SELECT 1 AS allowed
      FROM event_memberships
      WHERE user_id = ? AND role = 'organizer'
      LIMIT 1`,
    ).bind(session.userId).first<{ allowed: number }>();
    if (!organizer) {
      return errorResponse(context, 403, "FORBIDDEN", "Only an existing event organizer can create another event.");
    }

    const input = await parseEventCreate(context);
    if (input instanceof Response) return input;
    const existing = await context.env.DB.prepare(
      "SELECT 1 AS present FROM events WHERE slug = ? LIMIT 1",
    ).bind(input.slug).first<{ present: number }>();
    if (existing) {
      return errorResponse(context, 409, "EVENT_SLUG_TAKEN", "That event workspace slug is already in use.");
    }

    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();
    const formatOptions = Object.entries(SESSION_FORMAT_DURATIONS).map(([value, durationMinutes]) => ({
      value,
      label: `${value[0]!.toUpperCase()}${value.slice(1).replace("_", " ")} (${durationMinutes} min)`,
      durationMinutes,
    }));
    const fields = [
      { key: "title", section: "session", type: "short_text", label: "Title", helpText: "Make it clear and specific.", required: 1, options: [], sortOrder: 10 },
      { key: "abstract", section: "session", type: "long_text", label: "Abstract", helpText: "Describe what attendees will learn.", required: 1, options: [], sortOrder: 20 },
      { key: "track", section: "session", type: "dropdown", label: "Track", helpText: "Choose the closest program track.", required: 1, options: [{ value: input.initialTrack, label: input.initialTrack }], sortOrder: 30 },
      { key: "format", section: "session", type: "dropdown", label: "Format", helpText: "Choose a supported session format.", required: 1, options: formatOptions, sortOrder: 40 },
    ] as const;

    try {
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO events (
            id, slug, name, tagline, location, description, starts_on, ends_on,
            cfp_deadline, status, time_zone
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?
          WHERE EXISTS (
            SELECT 1 FROM event_memberships
            WHERE user_id = ? AND role = 'organizer'
          )`,
        ).bind(
          eventId, input.slug, input.name, input.tagline, input.location,
          input.description, input.startsOn, input.endsOn, input.cfpClosesAt,
          input.timeZone, session.userId,
        ),
        context.env.DB.prepare(
          `INSERT INTO event_memberships (id, event_id, user_id, role, created_at)
          SELECT ?, id, ?, 'organizer', ? FROM events WHERE id = ?`,
        ).bind(crypto.randomUUID(), session.userId, now, eventId),
        context.env.DB.prepare(
          `INSERT INTO cfp_configs (
            event_id, status, opens_at, closes_at, confirmation_message,
            revision, created_at, updated_at
          )
          SELECT id, 'draft', ?, ?, ?, 1, ?, ? FROM events WHERE id = ?`,
        ).bind(
          input.cfpOpensAt,
          input.cfpClosesAt,
          "Thanks for sharing your proposal. You can view its status from this account.",
          now,
          now,
          eventId,
        ),
        ...fields.map((field) => context.env.DB.prepare(
          `INSERT INTO cfp_fields (
            id, event_id, field_key, section, field_type, label, help_text,
            required, options_json, sort_order, show_when_field_key,
            show_when_value, active
          )
          SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1
          FROM events WHERE id = ?`,
        ).bind(
          crypto.randomUUID(), field.key, field.section, field.type,
          field.label, field.helpText, field.required, JSON.stringify(field.options),
          field.sortOrder, eventId,
        )),
      ]);
      if (results[0]?.meta.changes !== 1) {
        return errorResponse(context, 403, "FORBIDDEN", "Only an existing event organizer can create another event.");
      }
    } catch (error) {
      const message = constraintMessage(error);
      if (/events\.slug|UNIQUE constraint failed: events\.slug/i.test(message)) {
        return errorResponse(context, 409, "EVENT_SLUG_TAKEN", "That event workspace slug is already in use.");
      }
      throw error;
    }

    return context.json({
      data: {
        event: { slug: input.slug, name: input.name, status: "draft" as const },
        session: await sessionProjection(context, session),
      },
      requestId: context.get("requestId"),
    }, 201);
  });

  routes.use("/events/:eventSlug/readiness", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/readiness", async (context) => {
    const readiness = await getProgramReadiness(context.env.DB, context.get("authEventId"));
    if (!readiness) {
      return errorResponse(context, 404, "EVENT_NOT_FOUND", "The requested event does not exist.");
    }

    const parsed = programReadinessResponseSchema.safeParse(readiness);
    if (!parsed.success) {
      console.error("Program readiness contract violation", {
        requestId: context.get("requestId"),
        eventId: context.get("authEventId"),
        issues: parsed.error.issues,
      });
      return errorResponse(context, 500, "READINESS_INVALID", "Program readiness could not be calculated.");
    }

    return context.json({
      data: parsed.data,
      requestId: context.get("requestId"),
    });
  });

  return routes;
}
