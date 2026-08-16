import { personalCalendarRequestSchema, type PublicProgramResponse } from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { errorResponse } from "../../http";
import { readBoundedRequestBody } from "../../request-safety";
import {
  EmbedNotFoundError,
  getPublicEmbed,
  getPublicProgram,
  PublicEventNotFoundError,
} from "./public-program-service";
import type { AppBindings } from "../../types";

const MAX_PERSONAL_CALENDAR_REQUEST_BYTES = 16 * 1024;

function escapeText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function calendarTimestamp(timestamp: string) {
  return new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function calendarUidDomain(configuredDomain: string | undefined, requestUrl: string) {
  const configured = configuredDomain?.trim().toLowerCase();
  if (configured && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(configured)) {
    return configured;
  }
  const hostname = new URL(requestUrl).hostname.toLowerCase();
  return hostname.replace(/^\[|\]$/g, "").replace(/[^a-z0-9.-]/g, "-") || "localhost";
}

export function foldCalendarLine(line: string) {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let byteLength = 0;
  for (const character of line) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > 75) {
      lines.push(current);
      current = ` ${character}`;
      byteLength = 1 + characterBytes;
    } else {
      current += character;
      byteLength += characterBytes;
    }
  }
  lines.push(current);
  return lines.join("\r\n");
}

export function serializeICalendar(
  program: PublicProgramResponse,
  dtstamp: string,
  uidDomain: string,
  calendarName = program.event.name,
) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ConfPilot//Conference Program//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${escapeText(program.event.timeZone)}`,
  ];
  for (const session of program.sessions) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.slug}.${program.event.slug}@${uidDomain}`,
      `DTSTAMP:${calendarTimestamp(dtstamp)}`,
      `DTSTART:${calendarTimestamp(session.schedule.startsAt)}`,
      `DTEND:${calendarTimestamp(session.schedule.endsAt)}`,
      `SUMMARY:${escapeText(session.title)}`,
      `DESCRIPTION:${escapeText(session.abstract)}`,
      `LOCATION:${escapeText(`${session.schedule.room}, ${program.event.location}`)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
}

async function entityTag(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

function etagMatches(header: string | undefined, target: string) {
  if (!header) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const normalized = normalize(candidate);
    return normalized === "*" || normalized === normalize(target);
  });
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
}

async function selectedCalendarRequest(context: Context<AppBindings>) {
  const body = await readBoundedRequestBody(
    context.req.raw,
    MAX_PERSONAL_CALENDAR_REQUEST_BYTES,
  );
  if (!body.ok && body.reason === "invalid-content-length") {
    return errorResponse(context, 400, "INVALID_CONTENT_LENGTH",
      "Content-Length must be a non-negative integer.");
  }
  if (!body.ok) {
    return errorResponse(context, 413, "REQUEST_TOO_LARGE",
      "The request body exceeds the personal-calendar size limit.");
  }

  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body.bytes));
  } catch {
    return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  const result = personalCalendarRequestSchema.safeParse(input);
  if (!result.success) {
    return errorResponse(context, 400, "SESSIONS_INVALID",
      "Select between 1 and 100 sessions using their public slugs.", zodIssues(result.error));
  }
  return result.data;
}

async function calendarResponse(
  context: Context<AppBindings>,
  eventSlug: string,
  selectedSlugs?: string[],
) {
  try {
    const [publicProgram, stamp] = await Promise.all([
      getPublicProgram(context.env.DB, eventSlug),
      context.env.DB.prepare(`SELECT COALESCE(agenda_published_at, starts_on || 'T00:00:00Z') AS value
        FROM events WHERE slug = ? AND status = 'published' LIMIT 1`)
        .bind(eventSlug).first<{ value: string }>(),
    ]);
    const selected = selectedSlugs ? new Set(selectedSlugs) : null;
    const program = selected === null ? publicProgram : {
      ...publicProgram,
      sessions: publicProgram.sessions.filter((session) => selected.has(session.slug)),
    };
    if (selected !== null && program.sessions.length !== selected.size) {
      return errorResponse(context, 409, "SESSIONS_CHANGED",
        "One or more selected sessions are no longer public. Refresh the program and try again.");
    }
    const body = serializeICalendar(
      program,
      stamp?.value ?? `${program.event.startsOn}T00:00:00Z`,
      calendarUidDomain(context.env.CALENDAR_UID_DOMAIN, context.req.url),
    );
    context.header("cache-control", selected === null
      ? "public, max-age=0, must-revalidate"
      : "private, no-store");
    if (selected === null) {
      const etag = await entityTag(body);
      context.header("etag", etag);
      if (etagMatches(context.req.header("if-none-match"), etag)) return context.body(null, 304);
    }
    context.header("content-type", "text/calendar; charset=utf-8");
    const suffix = selected === null ? "" : "-my-schedule";
    context.header("content-disposition", `attachment; filename="${program.event.slug}${suffix}.ics"`);
    return context.body(body);
  } catch (error) {
    if (error instanceof PublicEventNotFoundError) return errorResponse(context, 404,
      "EVENT_NOT_FOUND", "The requested event does not exist.");
    throw error;
  }
}

export async function publicEmbedCalendarResponse(
  context: Context<AppBindings>,
  eventSlug: string,
  embedSlug: string,
) {
  try {
    const [embed, stamp] = await Promise.all([
      getPublicEmbed(context.env.DB, eventSlug, embedSlug),
      context.env.DB.prepare(`SELECT COALESCE(agenda_published_at, starts_on || 'T00:00:00Z') AS value
        FROM events WHERE slug = ? AND status = 'published' LIMIT 1`)
        .bind(eventSlug).first<{ value: string }>(),
    ]);
    const body = serializeICalendar(
      embed.program,
      stamp?.value ?? `${embed.program.event.startsOn}T00:00:00Z`,
      calendarUidDomain(context.env.CALENDAR_UID_DOMAIN, context.req.url),
      `${embed.program.event.name} — ${embed.embed.name}`,
    );
    const tag = await entityTag(body);
    context.header("cache-control", "public, max-age=0, must-revalidate");
    context.header("etag", tag);
    if (etagMatches(context.req.header("if-none-match"), tag)) return context.body(null, 304);
    context.header("content-type", "text/calendar; charset=utf-8");
    context.header("content-disposition",
      `attachment; filename="${embed.program.event.slug}-${embed.embed.slug}.ics"`);
    return context.body(body);
  } catch (error) {
    if (error instanceof PublicEventNotFoundError) return errorResponse(context, 404,
      "EVENT_NOT_FOUND", "The requested event does not exist.");
    if (error instanceof EmbedNotFoundError) return errorResponse(context, 404,
      "EMBED_NOT_FOUND", "The requested embed is not available.");
    throw error;
  }
}

export function createCalendarRoutes() {
  const routes = new Hono<AppBindings>();
  routes.get("/program.ics", async (context) => {
    const eventSlug = context.req.query("event")?.trim();
    if (!eventSlug) return errorResponse(context, 400, "EVENT_REQUIRED",
      "Provide an event slug in the event query parameter.");
    if (context.req.queries("session") !== undefined) return errorResponse(context, 400,
      "SESSIONS_IN_BODY_REQUIRED", "Use the personal-calendar POST endpoint for selected sessions.");
    return calendarResponse(context, eventSlug);
  });
  routes.post("/program.ics", async (context) => {
    const request = await selectedCalendarRequest(context);
    if (request instanceof Response) return request;
    return calendarResponse(context, request.event, request.sessionSlugs);
  });
  return routes;
}
