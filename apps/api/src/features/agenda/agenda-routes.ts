import {
  agendaAutoPlaceRequestSchema,
  agendaAutoPlaceResponseSchema,
  agendaDayCreateSchema,
  agendaDayUpdateSchema,
  agendaPlacementCreateSchema,
  agendaPlacementDeleteSchema,
  agendaPlacementUpdateSchema,
  agendaPublishResponseSchema,
  agendaResponseSchema,
  agendaRoomCreateSchema,
  agendaRoomUpdateSchema,
  agendaTrackCreateSchema,
  agendaTrackUpdateSchema,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import {
  AgendaConflictError,
  AgendaNotFoundError,
  autoPlaceAgenda,
  createAgendaDay,
  createAgendaPlacement,
  createAgendaRoom,
  createAgendaTrack,
  deleteAgendaPlacement,
  getAgenda,
  publishAgenda,
  updateAgendaDay,
  updateAgendaPlacement,
  updateAgendaRoom,
  updateAgendaTrack,
} from "./agenda-service";
import { requireEventRole } from "../../auth";
import { errorResponse } from "../../http";
import type { AppBindings } from "../../types";

function currentTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
}

async function parseJson<T>(context: Context<AppBindings>, schema: {
  safeParse: (input: unknown) => { success: true; data: T } | {
    success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
}): Promise<T | Response> {
  let input: unknown;
  try { input = await context.req.json(); }
  catch { return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON."); }
  const result = schema.safeParse(input);
  if (!result.success) return errorResponse(context, 400, "VALIDATION_FAILED",
    "Check the submitted fields and try again.", zodIssues(result.error));
  return result.data;
}

function contractData(context: Context<AppBindings>, data: unknown, status: 200 | 201 = 200) {
  const result = agendaResponseSchema.safeParse(data);
  if (!result.success) {
    console.error("Agenda response contract violation", {
      requestId: context.get("requestId"),
      issues: result.error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String) })),
    });
    return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION",
      "The agenda response could not be produced safely.");
  }
  return context.json({ data: result.data, requestId: context.get("requestId") }, status);
}

function specializedContractData<T>(context: Context<AppBindings>, schema: {
  safeParse: (input: unknown) => { success: true; data: T } | {
    success: false; error: { issues: Array<{ code: string; path: PropertyKey[] }> };
  };
}, data: T) {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error("Agenda mutation response contract violation", {
      requestId: context.get("requestId"),
      issues: result.error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String) })),
    });
    return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION",
      "The agenda response could not be produced safely.");
  }
  return context.json({ data: result.data, requestId: context.get("requestId") });
}

function routeError(context: Context<AppBindings>, error: unknown) {
  if (error instanceof AgendaNotFoundError) {
    const code = error.entity === "event" ? "EVENT_NOT_FOUND" : `${error.entity.toUpperCase()}_NOT_FOUND`;
    return errorResponse(context, 404, code, `The requested ${error.entity} does not exist.`);
  }
  if (error instanceof AgendaConflictError) {
    const values = {
      AGENDA_HAS_CONFLICTS: ["AGENDA_HAS_CONFLICTS", "Resolve all speaker conflicts before publishing."],
      DAY_REFERENCED: ["DAY_HAS_PLACEMENTS", "Unplace the day's sessions before changing its schedule window."],
      IDENTITY: ["AGENDA_CONFLICT", "An agenda item with this identity already has different values."],
      NOTHING_TO_PUBLISH: ["NOTHING_TO_PUBLISH", "Place at least one session before publishing the agenda."],
      NO_PUBLIC_SESSIONS: ["NO_PUBLIC_SESSIONS", "Schedule and approve at least one session with a public primary speaker before publishing."],
      REVISION: ["REVISION_CONFLICT", "This agenda item changed. Reload it and try again."],
      ROOM_OVERLAP: ["ROOM_CONFLICT", "That room is already occupied during the selected time."],
      SESSION_ALREADY_SCHEDULED: ["SESSION_ALREADY_SCHEDULED", "Move the existing placement instead of creating another one."],
      SESSION_NOT_SCHEDULABLE: ["SESSION_NOT_SCHEDULABLE", "Only accepted event sessions can be scheduled."],
      TIME_INVALID: ["OUTSIDE_EVENT_DAY", "Choose a time aligned to the selected day's operating window."],
    } as const;
    const [code, message] = values[error.reason];
    return errorResponse(context, 409, code, message);
  }
  throw error;
}

export function createAgendaRoutes() {
  const routes = new Hono<AppBindings>();
  routes.use("/events/:eventSlug/agenda", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/agenda/*", requireEventRole("organizer"));

  const canonicalAgenda = (context: Context<AppBindings>, status: 200 | 201 = 200) =>
    getAgenda(context.env.DB, context.get("authEventId"))
      .then((agenda) => contractData(context, agenda, status));

  routes.get("/events/:eventSlug/agenda", async (context) => {
    try { return await canonicalAgenda(context); }
    catch (error) { return routeError(context, error); }
  });

  routes.post("/events/:eventSlug/agenda/rooms", async (context) => {
    const value = await parseJson(context, agendaRoomCreateSchema);
    if (value instanceof Response) return value;
    try {
      await createAgendaRoom(context.env.DB, { eventId: context.get("authEventId"),
        actorUserId: context.get("authUserId"), value, now: currentTimestamp() });
      return await canonicalAgenda(context, 201);
    } catch (error) { return routeError(context, error); }
  });

  routes.patch("/events/:eventSlug/agenda/rooms/:roomId", async (context) => {
    const value = await parseJson(context, agendaRoomUpdateSchema);
    if (value instanceof Response) return value;
    try {
      await updateAgendaRoom(context.env.DB, { eventId: context.get("authEventId"),
        roomId: context.req.param("roomId"), actorUserId: context.get("authUserId"),
        value, now: currentTimestamp() });
      return await canonicalAgenda(context);
    } catch (error) { return routeError(context, error); }
  });

  routes.post("/events/:eventSlug/agenda/tracks", async (context) => {
    const value = await parseJson(context, agendaTrackCreateSchema);
    if (value instanceof Response) return value;
    try {
      await createAgendaTrack(context.env.DB, { eventId: context.get("authEventId"),
        actorUserId: context.get("authUserId"), value, now: currentTimestamp() });
      return await canonicalAgenda(context, 201);
    } catch (error) { return routeError(context, error); }
  });

  routes.patch("/events/:eventSlug/agenda/tracks/:trackId", async (context) => {
    const value = await parseJson(context, agendaTrackUpdateSchema);
    if (value instanceof Response) return value;
    try {
      await updateAgendaTrack(context.env.DB, { eventId: context.get("authEventId"),
        trackId: context.req.param("trackId"), actorUserId: context.get("authUserId"),
        value, now: currentTimestamp() });
      return await canonicalAgenda(context);
    } catch (error) { return routeError(context, error); }
  });

  routes.post("/events/:eventSlug/agenda/days", async (context) => {
    const value = await parseJson(context, agendaDayCreateSchema);
    if (value instanceof Response) return value;
    try {
      await createAgendaDay(context.env.DB, { eventId: context.get("authEventId"),
        actorUserId: context.get("authUserId"), value, now: currentTimestamp() });
      return await canonicalAgenda(context, 201);
    } catch (error) { return routeError(context, error); }
  });

  routes.patch("/events/:eventSlug/agenda/days/:dayId", async (context) => {
    const value = await parseJson(context, agendaDayUpdateSchema);
    if (value instanceof Response) return value;
    try {
      await updateAgendaDay(context.env.DB, { eventId: context.get("authEventId"),
        dayId: context.req.param("dayId"), actorUserId: context.get("authUserId"),
        value, now: currentTimestamp() });
      return await canonicalAgenda(context);
    } catch (error) { return routeError(context, error); }
  });

  routes.post("/events/:eventSlug/agenda/placements", async (context) => {
    const value = await parseJson(context, agendaPlacementCreateSchema);
    if (value instanceof Response) return value;
    try {
      await createAgendaPlacement(context.env.DB, { eventId: context.get("authEventId"),
        actorUserId: context.get("authUserId"), value, now: currentTimestamp() });
      return await canonicalAgenda(context, 201);
    } catch (error) { return routeError(context, error); }
  });

  routes.patch("/events/:eventSlug/agenda/placements/:placementId", async (context) => {
    const value = await parseJson(context, agendaPlacementUpdateSchema);
    if (value instanceof Response) return value;
    try {
      await updateAgendaPlacement(context.env.DB, { eventId: context.get("authEventId"),
        placementId: context.req.param("placementId"), actorUserId: context.get("authUserId"),
        value, now: currentTimestamp() });
      return await canonicalAgenda(context);
    } catch (error) { return routeError(context, error); }
  });

  routes.delete("/events/:eventSlug/agenda/placements/:placementId", async (context) => {
    const queryRevision = context.req.query("expectedRevision");
    const value = queryRevision === undefined
      ? await parseJson(context, agendaPlacementDeleteSchema)
      : agendaPlacementDeleteSchema.safeParse({ expectedRevision: Number(queryRevision) });
    if (value instanceof Response) return value;
    if ("success" in value && !value.success) return errorResponse(context, 400, "VALIDATION_FAILED",
      "Provide a positive expectedRevision query value.");
    const expectedRevision = "success" in value ? value.data.expectedRevision : value.expectedRevision;
    try {
      await deleteAgendaPlacement(context.env.DB, { eventId: context.get("authEventId"),
        placementId: context.req.param("placementId"), expectedRevision, now: currentTimestamp() });
      return await canonicalAgenda(context);
    } catch (error) { return routeError(context, error); }
  });

  routes.post("/events/:eventSlug/agenda/auto-place", async (context) => {
    const value = await parseJson(context, agendaAutoPlaceRequestSchema);
    if (value instanceof Response) return value;
    try {
      const data = await autoPlaceAgenda(context.env.DB, { eventId: context.get("authEventId"),
        actorUserId: context.get("authUserId"), value, now: currentTimestamp() });
      return specializedContractData(context, agendaAutoPlaceResponseSchema, data);
    } catch (error) { return routeError(context, error); }
  });

  routes.post("/events/:eventSlug/agenda/publish", async (context) => {
    try {
      const data = await publishAgenda(context.env.DB, {
        eventId: context.get("authEventId"), now: currentTimestamp(),
      });
      return specializedContractData(context, agendaPublishResponseSchema, data);
    } catch (error) { return routeError(context, error); }
  });

  return routes;
}
