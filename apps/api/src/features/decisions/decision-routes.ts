import {
  decisionListResponseSchema,
  decisionRecordRequestSchema,
  decisionRecordResponseSchema,
  notificationPreviewResponseSchema,
  notificationQueueRequestSchema,
  notificationQueueResponseSchema,
  ownerWorkspaceResponseSchema,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { AcceptanceNotAllowedError } from "./acceptance";
import { requireEventRole } from "../../auth";
import {
  DecisionConflictError,
  DecisionNotAllowedError,
  DecisionNotFoundError,
  NotificationConflictError,
  NotificationNotAllowedError,
  listDecisions,
  ownerWorkspace,
  previewDecisionNotification,
  queueDecisionNotification,
  recordDecision,
} from "./decision-service";
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
    console.error("Decision response contract violation", {
      requestId: context.get("requestId"),
      issues: result.error.issues,
    });
    return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION", "The decision response could not be produced safely.");
  }
  return context.json({ data: result.data, requestId: context.get("requestId") }, status);
}

function serviceError(context: Context<AppBindings>, error: unknown) {
  if (error instanceof DecisionNotFoundError) {
    return errorResponse(context, 404, "DECISION_NOT_FOUND", "The requested proposal or decision does not exist.");
  }
  if (error instanceof DecisionConflictError) {
    return errorResponse(context, 409, "DECISION_ALREADY_RECORDED", "A different immutable decision has already been recorded for this proposal.");
  }
  if (error instanceof DecisionNotAllowedError) {
    return errorResponse(context, 409, "DECISION_NOT_ALLOWED", "Only submitted proposals without a decision can be decided.");
  }
  if (error instanceof AcceptanceNotAllowedError) {
    return errorResponse(context, 409, "ACCEPTANCE_NOT_ALLOWED", "An accepted proposal must have exactly one primary presenter before its session can be created.");
  }
  if (error instanceof NotificationConflictError) {
    return errorResponse(context, 409, "NOTIFICATION_ALREADY_QUEUED", "A different notification snapshot has already been queued for this decision.");
  }
  if (error instanceof NotificationNotAllowedError) {
    return errorResponse(context, 409, "NOTIFICATION_NOT_ALLOWED", "This decision is not ready for notification.");
  }
  throw error;
}

export function createDecisionRoutes() {
  const routes = new Hono<AppBindings>();
  routes.use("/events/:eventSlug/decisions", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/decisions/*", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/speaker/workspace", requireEventRole("speaker"));
  routes.use("/events/:eventSlug/speaker/workspace/*", requireEventRole("speaker"));

  routes.get("/events/:eventSlug/decisions", async (context) => {
    try {
      const data = await listDecisions(
        context.env.DB,
        context.get("authEventId"),
        context.req.param("eventSlug"),
      );
      return contractData(context, decisionListResponseSchema, data);
    } catch (error) {
      return serviceError(context, error);
    }
  });

  routes.post("/events/:eventSlug/decisions", async (context) => {
    const input = await parseJson(context, decisionRecordRequestSchema);
    if (input instanceof Response) return input;
    try {
      const data = await recordDecision(context.env.DB, {
        eventId: context.get("authEventId"),
        proposalId: input.proposalId,
        decision: input.decision,
        rationale: input.rationale,
        decidedByUserId: context.get("authUserId"),
        decidedAt: currentTimestamp(),
      });
      return contractData(context, decisionRecordResponseSchema, data, 201);
    } catch (error) {
      return serviceError(context, error);
    }
  });

  routes.get("/events/:eventSlug/decisions/:decisionId/notification-preview", async (context) => {
    try {
      const data = await previewDecisionNotification(
        context.env.DB,
        context.get("authEventId"),
        context.req.param("decisionId"),
      );
      return contractData(context, notificationPreviewResponseSchema, data);
    } catch (error) {
      return serviceError(context, error);
    }
  });

  routes.post("/events/:eventSlug/decisions/:decisionId/notification", async (context) => {
    const input = await parseJson(context, notificationQueueRequestSchema);
    if (input instanceof Response) return input;
    try {
      const data = await queueDecisionNotification(context.env.DB, {
        eventId: context.get("authEventId"),
        decisionId: context.req.param("decisionId"),
        queuedByUserId: context.get("authUserId"),
        subject: input.subject,
        body: input.body,
        queuedAt: currentTimestamp(),
      });
      return contractData(context, notificationQueueResponseSchema, data, 201);
    } catch (error) {
      return serviceError(context, error);
    }
  });

  routes.get("/events/:eventSlug/speaker/workspace", async (context) => {
    try {
      const data = await ownerWorkspace(
        context.env.DB,
        context.get("authEventId"),
        context.get("authUserId"),
      );
      return contractData(context, ownerWorkspaceResponseSchema, data);
    } catch (error) {
      return serviceError(context, error);
    }
  });

  return routes;
}
