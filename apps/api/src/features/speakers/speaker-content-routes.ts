import {
  contentCommentCreateSchema,
  contentReviewCreateSchema,
  deliverableRequestCreateSchema,
  deliverableRequestUpdateSchema,
  deliverableUploadMetadataSchema,
  organizerSpeakerTaskUpdateSchema,
  sessionApprovalUpdateSchema,
  sessionContentUpdateSchema,
  speakerRosterRowSchema,
  speakerReminderEnqueueSchema,
  speakerOwnedProfileUpdateSchema,
  speakerProfileUpdateSchema,
  speakerTaskBulkCreateSchema,
  speakerTaskUpdateSchema,
  speakerVisibilityUpdateSchema,
  speakerWorkflowUpdateSchema,
} from "@confpilot/contracts";
import type {
  ContentCommentCreate,
  ContentReviewCreate,
  DeliverableRequestCreate,
  DeliverableRequestUpdate,
  OrganizerSpeakerTaskUpdate,
  SessionApprovalUpdate,
  SessionContentUpdate,
  SpeakerOwnedProfileUpdate,
  SpeakerProfileUpdate,
  SpeakerRosterRow,
  SpeakerReminderEnqueue,
  SpeakerTaskBulkCreate,
  SpeakerTaskUpdate,
  SpeakerVisibilityUpdate,
  SpeakerWorkflowUpdate,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { requireEventRole } from "../../auth";
import { errorResponse } from "../../http";
import type { AppBindings } from "../../types";

type RouteContext = Context<AppBindings>;
const MAX_MULTIPART_BODY_BYTES = 11 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
type RouteHandler<T = undefined> = (
  context: RouteContext,
  input: T,
) => Response | Promise<Response>;

export interface SpeakerContentRouteHandlers {
  speakerWorkspace: RouteHandler;
  updateSpeakerProfile: RouteHandler<SpeakerOwnedProfileUpdate>;
  uploadOwnHeadshot: RouteHandler<{ file: File }>;
  downloadOwnHeadshot: RouteHandler;
  updateOwnTask: RouteHandler<SpeakerTaskUpdate>;
  uploadDeliverable: RouteHandler<{ file: File; note: string; idempotencyKey: string }>;
  downloadSpeakerDeliverable: RouteHandler;
  createSpeakerComment: RouteHandler<ContentCommentCreate>;
  organizerRoster: RouteHandler;
  createOrganizerSpeaker: RouteHandler<SpeakerRosterRow>;
  importOrganizerSpeakers: RouteHandler<{ file: File }>;
  speakerReminderTemplates: RouteHandler;
  enqueueSpeakerReminder: RouteHandler<SpeakerReminderEnqueue>;
  organizerContent: RouteHandler;
  exportOrganizerDeliverables: RouteHandler;
  updateSessionApproval: RouteHandler<SessionApprovalUpdate>;
  createDeliverableRequest: RouteHandler<DeliverableRequestCreate>;
  updateDeliverableRequest: RouteHandler<DeliverableRequestUpdate>;
  createContentReview: RouteHandler<ContentReviewCreate>;
  createOrganizerComment: RouteHandler<ContentCommentCreate>;
  updateSessionContent: RouteHandler<SessionContentUpdate>;
  restoreSessionContent: RouteHandler;
  downloadOrganizerDeliverable: RouteHandler;
  updateOrganizerTask: RouteHandler<OrganizerSpeakerTaskUpdate>;
  createBulkTasks: RouteHandler<SpeakerTaskBulkCreate>;
  updateOrganizerSpeakerProfile: RouteHandler<SpeakerProfileUpdate>;
  updateSpeakerVisibility: RouteHandler<SpeakerVisibilityUpdate>;
  updateSpeakerWorkflow: RouteHandler<SpeakerWorkflowUpdate>;
  uploadOrganizerHeadshot: RouteHandler<{ file: File }>;
  downloadOrganizerHeadshot: RouteHandler;
  restoreSpeakerProfile: RouteHandler;
  publicHeadshot: RouteHandler;
}

function unavailable(context: RouteContext) {
  return errorResponse(
    context,
    500,
    "FEATURE_NOT_READY",
    "The speaker content workflow is not available yet.",
  );
}

const unavailableHandlers: SpeakerContentRouteHandlers = {
  speakerWorkspace: unavailable,
  updateSpeakerProfile: unavailable,
  uploadOwnHeadshot: unavailable,
  downloadOwnHeadshot: unavailable,
  updateOwnTask: unavailable,
  uploadDeliverable: unavailable,
  downloadSpeakerDeliverable: unavailable,
  createSpeakerComment: unavailable,
  organizerRoster: unavailable,
  createOrganizerSpeaker: unavailable,
  importOrganizerSpeakers: unavailable,
  speakerReminderTemplates: unavailable,
  enqueueSpeakerReminder: unavailable,
  organizerContent: unavailable,
  exportOrganizerDeliverables: unavailable,
  updateSessionApproval: unavailable,
  createDeliverableRequest: unavailable,
  updateDeliverableRequest: unavailable,
  createContentReview: unavailable,
  createOrganizerComment: unavailable,
  updateSessionContent: unavailable,
  restoreSessionContent: unavailable,
  downloadOrganizerDeliverable: unavailable,
  updateOrganizerTask: unavailable,
  createBulkTasks: unavailable,
  updateOrganizerSpeakerProfile: unavailable,
  updateSpeakerVisibility: unavailable,
  updateSpeakerWorkflow: unavailable,
  uploadOrganizerHeadshot: unavailable,
  downloadOrganizerHeadshot: unavailable,
  restoreSpeakerProfile: unavailable,
  publicHeadshot: unavailable,
};

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
}

async function parseJson<T>(
  context: RouteContext,
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

async function parseMultipart(
  context: RouteContext,
  allowedTextFields: readonly string[],
): Promise<{ file: File; text: Record<string, string> } | Response> {
  const tooLarge = () => context.json({
    error: {
      code: "UPLOAD_TOO_LARGE",
      message: "The upload exceeds the request size limit.",
      requestId: context.get("requestId"),
    },
  }, 413);
  const contentLength = context.req.header("content-length");
  if (contentLength && !/^\d+$/.test(contentLength)) {
    return errorResponse(context, 400, "INVALID_CONTENT_LENGTH", "Content-Length must be a non-negative integer.");
  }
  if (contentLength && Number(contentLength) > MAX_MULTIPART_BODY_BYTES) {
    return tooLarge();
  }
  let form: FormData;
  try {
    const contentType = context.req.header("content-type");
    const body = context.req.raw.body;
    if (!contentType || !body) throw new Error("Multipart content type and body are required.");
    const reader = body.getReader();
    const bounded = new Uint8Array(MAX_MULTIPART_BODY_BYTES);
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MAX_MULTIPART_BODY_BYTES) {
        await reader.cancel();
        return tooLarge();
      }
      bounded.set(value, total);
      total += value.byteLength;
    }
    form = await new Request(context.req.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: bounded.subarray(0, total),
    }).formData();
  } catch {
    return errorResponse(context, 400, "INVALID_MULTIPART", "Provide a valid multipart upload.");
  }
  const allowed = new Set(["file", ...allowedTextFields]);
  for (const key of form.keys()) {
    if (!allowed.has(key)) {
      return errorResponse(context, 400, "VALIDATION_FAILED", "The upload contains an unknown field.");
    }
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return errorResponse(context, 400, "FILE_REQUIRED", "Choose a non-empty file to upload.");
  }
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    return context.json({
      error: {
        code: "FILE_TOO_LARGE",
        message: "The file exceeds the 10 MiB upload limit.",
        requestId: context.get("requestId"),
      },
    }, 413);
  }
  const text: Record<string, string> = {};
  for (const field of allowedTextFields) {
    const value = form.get(field);
    if (value instanceof File) {
      return errorResponse(context, 400, "VALIDATION_FAILED", `${field} must be text.`);
    }
    text[field] = value ?? "";
  }
  return { file, text };
}

export function createSpeakerContentRoutes(
  overrides: Partial<SpeakerContentRouteHandlers> = {},
) {
  const handlers = { ...unavailableHandlers, ...overrides };
  const routes = new Hono<AppBindings>();

  routes.use("/events/:eventSlug/speaker/*", requireEventRole("speaker"));
  routes.use("/events/:eventSlug/speakers", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/speakers/*", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/content", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/content/*", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/speaker/content-workspace", (context) =>
    handlers.speakerWorkspace(context, undefined));
  routes.patch("/events/:eventSlug/speaker/profile", async (context) => {
    const input = await parseJson(context, speakerOwnedProfileUpdateSchema);
    return input instanceof Response ? input : handlers.updateSpeakerProfile(context, input);
  });
  routes.post("/events/:eventSlug/speaker/headshot", async (context) => {
    const input = await parseMultipart(context, []);
    return input instanceof Response
      ? input
      : handlers.uploadOwnHeadshot(context, { file: input.file });
  });
  routes.get("/events/:eventSlug/speaker/headshot/file", (context) =>
    handlers.downloadOwnHeadshot(context, undefined));
  routes.patch("/events/:eventSlug/speaker/tasks/:taskId", async (context) => {
    const input = await parseJson(context, speakerTaskUpdateSchema);
    return input instanceof Response ? input : handlers.updateOwnTask(context, input);
  });
  routes.post("/events/:eventSlug/speaker/deliverables/:requestId/versions", async (context) => {
    const upload = await parseMultipart(context, ["note"]);
    if (upload instanceof Response) return upload;
    const metadata = deliverableUploadMetadataSchema.safeParse({
      idempotencyKey: context.req.header("idempotency-key"),
      note: upload.text.note,
    });
    if (!metadata.success) {
      return errorResponse(
        context,
        400,
        "VALIDATION_FAILED",
        "Provide a valid Idempotency-Key and upload note.",
        zodIssues(metadata.error),
      );
    }
    return handlers.uploadDeliverable(context, { file: upload.file, ...metadata.data });
  });
  routes.get("/events/:eventSlug/speaker/deliverables/:versionId/file", (context) =>
    handlers.downloadSpeakerDeliverable(context, undefined));
  routes.post("/events/:eventSlug/speaker/sessions/:sessionId/comments", async (context) => {
    const input = await parseJson(context, contentCommentCreateSchema);
    return input instanceof Response ? input : handlers.createSpeakerComment(context, input);
  });

  routes.get("/events/:eventSlug/speakers", (context) =>
    handlers.organizerRoster(context, undefined));
  routes.post("/events/:eventSlug/speakers", async (context) => {
    const input = await parseJson(context, speakerRosterRowSchema);
    return input instanceof Response ? input : handlers.createOrganizerSpeaker(context, input);
  });
  routes.post("/events/:eventSlug/speakers/import", async (context) => {
    const input = await parseMultipart(context, []);
    return input instanceof Response
      ? input
      : handlers.importOrganizerSpeakers(context, { file: input.file });
  });
  routes.get("/events/:eventSlug/speakers/communications/templates", (context) =>
    handlers.speakerReminderTemplates(context, undefined));
  routes.post("/events/:eventSlug/speakers/communications/reminders", async (context) => {
    const input = await parseJson(context, speakerReminderEnqueueSchema);
    return input instanceof Response ? input : handlers.enqueueSpeakerReminder(context, input);
  });
  routes.get("/events/:eventSlug/content", (context) =>
    handlers.organizerContent(context, undefined));
  routes.get("/events/:eventSlug/content/deliverables.zip", (context) =>
    handlers.exportOrganizerDeliverables(context, undefined));
  routes.patch("/events/:eventSlug/content/:sessionId/approval", async (context) => {
    const input = await parseJson(context, sessionApprovalUpdateSchema);
    return input instanceof Response ? input : handlers.updateSessionApproval(context, input);
  });
  routes.post("/events/:eventSlug/content/:sessionId/requests", async (context) => {
    const input = await parseJson(context, deliverableRequestCreateSchema);
    return input instanceof Response ? input : handlers.createDeliverableRequest(context, input);
  });
  routes.patch("/events/:eventSlug/content/:sessionId/requests/:requestId", async (context) => {
    const input = await parseJson(context, deliverableRequestUpdateSchema);
    return input instanceof Response ? input : handlers.updateDeliverableRequest(context, input);
  });
  routes.post("/events/:eventSlug/content/:sessionId/reviews", async (context) => {
    const input = await parseJson(context, contentReviewCreateSchema);
    return input instanceof Response ? input : handlers.createContentReview(context, input);
  });
  routes.post("/events/:eventSlug/content/:sessionId/comments", async (context) => {
    const input = await parseJson(context, contentCommentCreateSchema);
    return input instanceof Response ? input : handlers.createOrganizerComment(context, input);
  });
  routes.patch("/events/:eventSlug/content/:sessionId", async (context) => {
    const input = await parseJson(context, sessionContentUpdateSchema);
    return input instanceof Response ? input : handlers.updateSessionContent(context, input);
  });
  routes.post("/events/:eventSlug/content/:sessionId/history/:historyId/restore", (context) =>
    handlers.restoreSessionContent(context, undefined));
  routes.get("/events/:eventSlug/content/deliverables/:versionId/file", (context) =>
    handlers.downloadOrganizerDeliverable(context, undefined));
  routes.patch("/events/:eventSlug/speakers/:speakerId/tasks/:taskId", async (context) => {
    const input = await parseJson(context, organizerSpeakerTaskUpdateSchema);
    return input instanceof Response ? input : handlers.updateOrganizerTask(context, input);
  });
  routes.post("/events/:eventSlug/speakers/tasks", async (context) => {
    const input = await parseJson(context, speakerTaskBulkCreateSchema);
    return input instanceof Response ? input : handlers.createBulkTasks(context, input);
  });
  routes.patch("/events/:eventSlug/speakers/:speakerId/profile", async (context) => {
    const input = await parseJson(context, speakerProfileUpdateSchema);
    return input instanceof Response ? input : handlers.updateOrganizerSpeakerProfile(context, input);
  });
  routes.patch("/events/:eventSlug/speakers/:speakerId/visibility", async (context) => {
    const input = await parseJson(context, speakerVisibilityUpdateSchema);
    return input instanceof Response ? input : handlers.updateSpeakerVisibility(context, input);
  });
  routes.patch("/events/:eventSlug/speakers/:speakerId/workflow", async (context) => {
    const input = await parseJson(context, speakerWorkflowUpdateSchema);
    return input instanceof Response ? input : handlers.updateSpeakerWorkflow(context, input);
  });
  routes.post("/events/:eventSlug/speakers/:speakerId/headshot", async (context) => {
    const input = await parseMultipart(context, []);
    return input instanceof Response
      ? input
      : handlers.uploadOrganizerHeadshot(context, { file: input.file });
  });
  routes.get("/events/:eventSlug/speakers/:speakerId/headshot/file", (context) =>
    handlers.downloadOrganizerHeadshot(context, undefined));
  routes.post("/events/:eventSlug/speakers/:speakerId/history/:historyId/restore", (context) =>
    handlers.restoreSpeakerProfile(context, undefined));

  routes.get("/public/events/:eventSlug/speakers/:speakerSlug/headshot", (context) =>
    handlers.publicHeadshot(context, undefined));

  return routes;
}
