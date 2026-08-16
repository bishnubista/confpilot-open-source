import {
  bulkSpeakerCommunicationEnqueueSchema,
  bulkSpeakerCommunicationResponseSchema,
  communicationHistoryResponseSchema,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { requireEventRole } from "../../auth";
import { errorResponse } from "../../http";
import { resolveEmailDeliveryRuntime } from "../../runtime/email-delivery-runtime";
import type { AppBindings } from "../../types";
import {
  CommunicationMergeResultError,
  enqueueBulkSpeakerCommunication,
  listCommunicationHistory,
} from "./communication-service";

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({ field: issue.path.map(String).join(".") || "form", message: issue.message }));
}

async function parseJson<T>(context: Context<AppBindings>, schema: {
  safeParse(input: unknown): { success: true; data: T } | {
    success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
}) {
  let body: unknown;
  try { body = await context.req.json(); }
  catch { return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON."); }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? parsed.data
    : errorResponse(context, 400, "VALIDATION_FAILED", "Check the communication fields and exact recipient selection.", issues(parsed.error));
}

function contractData<T>(context: Context<AppBindings>, schema: {
  safeParse(input: unknown): { success: true; data: T } | {
    success: false; error: { issues: Array<{ code: string; path: PropertyKey[] }> };
  };
}, value: T, subject: string, status: 200 | 201 = 200) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    console.error("Communication response contract violation", {
      requestId: context.get("requestId"),
      issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String) })),
    });
    return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION", `${subject} could not be produced safely.`);
  }
  return context.json({ data: parsed.data, requestId: context.get("requestId") }, status);
}

export function createCommunicationRoutes() {
  const routes = new Hono<AppBindings>();
  routes.use("/events/:eventSlug/communications", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/communications/*", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/communications", async (context) => {
    const runtime = resolveEmailDeliveryRuntime(context.env);
    const history = await listCommunicationHistory(
      context.env.DB,
      context.get("authEventId"),
      runtime.capability,
    );
    return contractData(context, communicationHistoryResponseSchema, history, "Communication history");
  });

  routes.post("/events/:eventSlug/communications/speakers/bulk", async (context) => {
    const input = await parseJson(context, bulkSpeakerCommunicationEnqueueSchema);
    if (input instanceof Response) return input;
    let result;
    try {
      result = await enqueueBulkSpeakerCommunication(
        context.env.DB,
        context.get("authEventId"),
        context.get("authUserId"),
        input,
        now(),
        new URL(context.req.url).origin,
      );
    } catch (error) {
      if (error instanceof CommunicationMergeResultError) {
        return errorResponse(context, 400, "COMMUNICATION_MERGE_RESULT_INVALID", error.message, [
          { field: error.field, message: error.message },
        ]);
      }
      throw error;
    }
    return contractData(context, bulkSpeakerCommunicationResponseSchema, result, "Bulk communication result", 201);
  });

  return routes;
}
