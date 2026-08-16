import {
  embedConfigCreateSchema,
  embedConfigListResponseSchema,
  embedConfigResponseSchema,
  embedConfigUpdateSchema,
  publicEmbedResponseSchema,
  publicProgramResponseSchema,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { requireEventRole } from "../../auth";
import { errorResponse } from "../../http";
import {
  createEmbedConfig,
  EmbedConflictError,
  EmbedNotFoundError,
  getPublicEmbed,
  getPublicProgram,
  listEmbedConfigs,
  PublicEventNotFoundError,
  updateEmbedConfig,
} from "./public-program-service";
import type { AppBindings } from "../../types";
import { publicEmbedCalendarResponse } from "./calendar-routes";

function currentTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
}

async function parseJson<T>(
  context: Context<AppBindings>,
  schema: {
    safeParse: (input: unknown) =>
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
): Promise<T | Response> {
  let input: unknown;
  try {
    input = await context.req.json();
  } catch {
    return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    return errorResponse(
      context,
      400,
      "VALIDATION_FAILED",
      "Check the submitted fields and try again.",
      zodIssues(result.error),
    );
  }
  return result.data;
}

function contractData<T>(
  context: Context<AppBindings>,
  schema: {
    safeParse: (input: unknown) =>
      | { success: true; data: T }
      | { success: false; error: { issues: unknown } };
  },
  data: NoInfer<T>,
  status: 200 | 201 = 200,
) {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error("Public program or embed response contract violation", {
      requestId: context.get("requestId"),
      issues: result.error.issues,
    });
    return errorResponse(
      context,
      500,
      "RESPONSE_CONTRACT_VIOLATION",
      "The public program response could not be produced safely.",
    );
  }
  return context.json({ data: result.data, requestId: context.get("requestId") }, status);
}

async function etag(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

async function publicContractData<T>(
  context: Context<AppBindings>,
  schema: {
    safeParse: (input: unknown) =>
      | { success: true; data: T }
      | { success: false; error: { issues: unknown } };
  },
  data: NoInfer<T>,
) {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error("Public response contract violation", {
      requestId: context.get("requestId"),
      issues: result.error.issues,
    });
    return errorResponse(
      context,
      500,
      "RESPONSE_CONTRACT_VIOLATION",
      "The public response could not be produced safely.",
    );
  }
  const body = { data: result.data };
  const entityTag = await etag(body);
  context.header("cache-control", "public, max-age=0, must-revalidate");
  context.header("etag", entityTag);
  if (etagMatches(context.req.header("if-none-match"), entityTag)) return context.body(null, 304);
  return context.json(body);
}

function etagMatches(header: string | undefined, entityTag: string) {
  if (!header) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  const target = normalize(entityTag);
  return header.split(",").some((candidate) => {
    const normalized = normalize(candidate);
    return normalized === "*" || normalized === target;
  });
}

function publicError(context: Context<AppBindings>, error: unknown) {
  if (error instanceof PublicEventNotFoundError) {
    return errorResponse(context, 404, "EVENT_NOT_FOUND", "The requested event does not exist.");
  }
  if (error instanceof EmbedNotFoundError) {
    return errorResponse(context, 404, "EMBED_NOT_FOUND", "The requested embed is not available.");
  }
  throw error;
}

function organizerError(context: Context<AppBindings>, error: unknown) {
  if (error instanceof EmbedNotFoundError) {
    return errorResponse(context, 404, "EMBED_NOT_FOUND", "The requested embed does not exist.");
  }
  if (error instanceof EmbedConflictError) {
    return errorResponse(
      context,
      409,
      "EMBED_CONFLICT",
      "The embed changed or the requested slug already has a different configuration.",
    );
  }
  throw error;
}

export function createPublicProgramRoutes() {
  const routes = new Hono<AppBindings>();

  routes.get("/program", async (context) => {
    const eventSlug = context.req.query("event")?.trim();
    if (!eventSlug) {
      return errorResponse(
        context,
        400,
        "EVENT_REQUIRED",
        "Provide an event slug in the event query parameter.",
      );
    }
    try {
      const program = await getPublicProgram(context.env.DB, eventSlug);
      return publicContractData(context, publicProgramResponseSchema, program);
    } catch (error) {
      return publicError(context, error);
    }
  });

  routes.get("/program/speakers", async (context) => {
    const eventSlug = context.req.query("event")?.trim();
    if (!eventSlug) {
      return errorResponse(
        context,
        400,
        "EVENT_REQUIRED",
        "Provide an event slug in the event query parameter.",
      );
    }
    try {
      const program = await getPublicProgram(context.env.DB, eventSlug);
      return publicContractData(
        context,
        publicProgramResponseSchema.pick({ event: true, speakers: true }),
        { event: program.event, speakers: program.speakers },
      );
    } catch (error) {
      return publicError(context, error);
    }
  });

  routes.get("/public/events/:eventSlug/embeds/:embedSlug/calendar.ics", (context) =>
    publicEmbedCalendarResponse(context, context.req.param("eventSlug"), context.req.param("embedSlug")));

  routes.get("/public/events/:eventSlug/embeds/:embedSlug", async (context) => {
    try {
      const data = await getPublicEmbed(
        context.env.DB,
        context.req.param("eventSlug"),
        context.req.param("embedSlug"),
      );
      return publicContractData(context, publicEmbedResponseSchema, data);
    } catch (error) {
      return publicError(context, error);
    }
  });

  return routes;
}

export function createEmbedRoutes() {
  const routes = new Hono<AppBindings>();
  routes.use("/events/:eventSlug/embeds", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/embeds/*", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/embeds", async (context) => {
    const data = await listEmbedConfigs(context.env.DB, context.get("authEventId"));
    return contractData(context, embedConfigListResponseSchema, data);
  });

  routes.post("/events/:eventSlug/embeds", async (context) => {
    const value = await parseJson(context, embedConfigCreateSchema);
    if (value instanceof Response) return value;
    try {
      const result = await createEmbedConfig(context.env.DB, {
        eventId: context.get("authEventId"),
        actorUserId: context.get("authUserId"),
        value,
        now: currentTimestamp(),
      });
      return contractData(
        context,
        embedConfigResponseSchema,
        result.embed,
        result.created ? 201 : 200,
      );
    } catch (error) {
      return organizerError(context, error);
    }
  });

  routes.patch("/events/:eventSlug/embeds/:embedId", async (context) => {
    const value = await parseJson(context, embedConfigUpdateSchema);
    if (value instanceof Response) return value;
    try {
      const data = await updateEmbedConfig(context.env.DB, {
        eventId: context.get("authEventId"),
        embedId: context.req.param("embedId"),
        actorUserId: context.get("authUserId"),
        value,
        now: currentTimestamp(),
      });
      return contractData(context, embedConfigResponseSchema, data);
    } catch (error) {
      return organizerError(context, error);
    }
  });

  return routes;
}
