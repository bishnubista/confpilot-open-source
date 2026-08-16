import {
  contentCommentResponseSchema,
  contentReviewResponseSchema,
  deliverableRequestResponseSchema,
  deliverableUploadResponseSchema,
  organizerContentListResponseSchema,
  organizerSpeakerRosterResponseSchema,
  speakerRosterIngestResponseSchema,
  speakerReminderEnqueueResponseSchema,
  speakerReminderTemplateListResponseSchema,
  sessionContentHistoryResponseSchema,
  speakerContentWorkspaceResponseSchema,
  speakerProfileResponseSchema,
  speakerTaskResponseSchema,
} from "@confpilot/contracts";
import type { Context } from "hono";

import { errorResponse } from "../../http";
import {
  PrivateFileValidationError,
  attachmentContentDisposition,
  safeAttachmentFilename,
  storePrivateFile,
  validatePrivateUpload,
  sha256Hex,
} from "../../private-file-storage";
import { createR2PrivateFileStore, type PrivateFileStore } from "../../runtime/private-file-store";
import type { AppBindings } from "../../types";
import {
  SpeakerReminderIdempotencyConflictError,
  SpeakerReminderIneligibleError,
  SpeakerReminderNotFoundError,
  SpeakerReminderTemplateNotFoundError,
  SpeakerReminderAuthorizationError,
  enqueueSpeakerReminder,
  listSpeakerReminderTemplates,
} from "../../speaker-reminders";
import {
  DeliverablesArchiveLimitError,
  planDeliverablesArchive,
  streamDeliverablesArchive,
  verifyDeliverablesArchiveObjects,
} from "./deliverables-archive";
import type { SpeakerContentRouteHandlers } from "./speaker-content-routes";
import {
  SpeakerContentApprovalBlockedError,
  SpeakerContentCanonicalUploadError,
  SpeakerContentConflictError,
  SpeakerContentDataIntegrityError,
  SpeakerContentNotAllowedError,
  SpeakerContentNotFoundError,
  approvedCurrentDeliverables,
  authorizedDeliverableFile,
  createContentComment,
  createContentReview,
  createBulkSpeakerTasks,
  createDeliverableRequest,
  deliverableUploadProjection,
  finalizeDeliverableVersion,
  finalizeHeadshot,
  getOrganizerContent,
  getOrganizerSpeakerRoster,
  getSpeakerContentWorkspace,
  headshotFile,
  privateFileIsReferenced,
  restoreSessionContent,
  restoreSpeakerProfile,
  speakerIdForUserSession,
  speakerForUpload,
  updateDeliverableRequest,
  updateOrganizerSpeakerTask,
  updateOrganizerSpeakerProfile,
  updateOwnedSpeakerProfile,
  updateOwnedSpeakerTask,
  updateSessionApproval,
  updateSessionContent,
  updateSpeakerVisibility,
  updateSpeakerWorkflow,
  uploadSource,
} from "./speaker-content-service";
import { constraintMessage } from "../../runtime/database";
import { parseSpeakerRosterCsv } from "./speaker-roster-csv";
import { ingestSpeakerRosterRows } from "./speaker-roster-ingest-service";

type RouteContext = Context<AppBindings>;

/**
 * Resolve the private file store for this request.
 *
 * Every private-file access in this module goes through the runtime port rather
 * than reaching for the R2 binding directly, so changing the storage provider is
 * a single-line change here instead of an edit at each call site.
 */
function privateFiles(context: RouteContext): PrivateFileStore {
  return createR2PrivateFileStore(context.env.FILES);
}

function utcSecond() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function routeParam(context: RouteContext, name: string) {
  return context.req.param(name) ?? "";
}

function dataResponse<T>(context: RouteContext, schema: { parse(value: unknown): T }, value: unknown) {
  return context.json({ data: schema.parse(value), requestId: context.get("requestId") });
}

function digestHex(value: ArrayBuffer | ArrayBufferView) {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function privateFileResponse(
  context: RouteContext,
  row: { eventId: string; objectKey: string; originalFilename: string; contentType: string; byteSize: number; sha256: string },
  disposition: "attachment" | "inline",
) {
  const object = await privateFiles(context).get(row.objectKey);
  if (!object || object.size !== row.byteSize
    || object.httpMetadata?.contentType !== row.contentType
    || object.customMetadata?.eventScope !== row.eventId
    || object.customMetadata?.originalFilename !== row.originalFilename
    || object.customMetadata?.sha256 !== row.sha256
    || !object.checksums?.sha256 || digestHex(object.checksums.sha256) !== row.sha256) {
    throw new Error("Private object metadata does not match its database record.");
  }
  const filename = safeAttachmentFilename(row.originalFilename);
  const contentDisposition = disposition === "attachment"
    ? attachmentContentDisposition(filename)
    : `inline; filename="${filename.replace(/["\\]/g, "_")}"`;
  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": contentDisposition,
      "content-length": String(row.byteSize),
      "content-type": row.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

function uploadError(context: RouteContext, error: unknown) {
  if (error instanceof PrivateFileValidationError) {
    if (error.code === "FILE_TOO_LARGE") {
      return context.json({ error: {
        code: error.code,
        message: error.message,
        requestId: context.get("requestId"),
      } }, 413);
    }
    return errorResponse(context, 400, error.code, error.message);
  }
  return serviceError(context, error);
}

function storedFileRow(file: Awaited<ReturnType<typeof storePrivateFile>>, eventId: string) {
  return {
    eventId,
    objectKey: file.key,
    originalFilename: file.filename,
    contentType: file.contentType,
    byteSize: file.size,
    sha256: file.sha256,
  };
}

const HEADSHOT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

async function uploadHeadshot(
  context: RouteContext,
  file: File,
  organizer: boolean,
) {
  try {
    const eventId = context.get("authEventId");
    const source = await speakerForUpload(context.env.DB, {
      eventId,
      ...(organizer
        ? { speakerId: routeParam(context, "speakerId") }
        : { userId: context.get("authUserId") }),
    });
    const previousKey = source.headshotObjectKey;
    const body = await file.arrayBuffer();
    let profile: unknown;
    let newKey: string | null = null;
    await storePrivateFile({
      bucket: privateFiles(context),
      eventScope: eventId,
      pathSegments: ["headshots", source.id],
      filename: file.name,
      contentType: file.type,
      body,
      allowedContentTypes: HEADSHOT_TYPES,
      maxBytes: 10 * 1024 * 1024,
      isReferenced: (stored) => privateFileIsReferenced(context.env.DB, eventId, stored.key),
      finalize: async (stored) => {
        newKey = stored.key;
        profile = await finalizeHeadshot(context.env.DB, {
          eventId,
          speakerId: source.id,
          expectedRevision: source.revision,
          ...(organizer ? { actorUserId: context.get("authUserId") } : {}),
          file: storedFileRow(stored, eventId),
          now: utcSecond(),
        });
      },
    });
    if (previousKey && previousKey !== newKey) {
      try {
        await privateFiles(context).delete(previousKey);
      } catch {
        console.warn("Old headshot cleanup failed", {
          requestId: context.get("requestId"),
        });
      }
    }
    return dataResponse(context, speakerProfileResponseSchema, profile);
  } catch (error) {
    return uploadError(context, error);
  }
}

async function publicHeadshotResponse(context: RouteContext) {
  try {
    const row = await headshotFile(context.env.DB, {
      eventSlug: routeParam(context, "eventSlug"),
      speakerSlug: routeParam(context, "speakerSlug"),
      public: true,
    });
    const version = row.sha256.slice(0, 12);
    const requestedVersion = context.req.query("v");
    if (requestedVersion && requestedVersion !== version) throw new SpeakerContentNotFoundError();
    const etag = `"${row.sha256}"`;
    // Revalidate even versioned headshots so making a speaker private takes
    // effect on the next request instead of leaving a year-long cached copy.
    const cacheControl = "public, max-age=0, must-revalidate";
    if (context.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { "cache-control": cacheControl, etag } });
    }
    const object = await privateFiles(context).get(row.objectKey);
    if (!object || object.size !== row.byteSize
      || object.httpMetadata?.contentType !== row.contentType
      || object.customMetadata?.eventScope !== row.eventId
      || object.customMetadata?.originalFilename !== row.originalFilename
      || object.customMetadata?.sha256 !== row.sha256
      || !object.checksums?.sha256 || digestHex(object.checksums.sha256) !== row.sha256) {
      throw new Error("Public headshot metadata does not match its database record.");
    }
    return new Response(object.body, { headers: {
      "cache-control": cacheControl,
      "content-length": String(row.byteSize),
      "content-type": row.contentType,
      etag,
      "x-content-type-options": "nosniff",
    } });
  } catch (error) {
    return serviceError(context, error);
  }
}

async function uploadDeliverableVersion(
  context: RouteContext,
  input: { file: File; note: string; idempotencyKey: string },
) {
  try {
    const eventId = context.get("authEventId");
    const requestId = routeParam(context, "requestId");
    const userId = context.get("authUserId");
    const body = await input.file.arrayBuffer();
    let source = await uploadSource(context.env.DB, { eventId, requestId, userId, idempotencyKey: input.idempotencyKey });
    if (source.canonical) {
      const valid = validatePrivateUpload(body, input.file.type, source.allowedContentTypes, source.source.maxBytes);
      const sha256 = await sha256Hex(valid.bytes);
      if (source.canonical.originalFilename !== safeAttachmentFilename(input.file.name)
        || source.canonical.contentType !== valid.contentType
        || source.canonical.byteSize !== valid.size
        || source.canonical.sha256 !== sha256
        || source.canonical.note !== input.note) throw new SpeakerContentConflictError();
      return dataResponse(
        context,
        deliverableUploadResponseSchema,
        await deliverableUploadProjection(context.env.DB, eventId, source.canonical),
      );
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let created: Awaited<ReturnType<typeof finalizeDeliverableVersion>> | null = null;
      try {
        await storePrivateFile({
          bucket: privateFiles(context),
          eventScope: eventId,
          pathSegments: ["deliverables", requestId],
          filename: input.file.name,
          contentType: input.file.type,
          body,
          allowedContentTypes: source.allowedContentTypes,
          maxBytes: source.source.maxBytes,
          isReferenced: (stored) => privateFileIsReferenced(context.env.DB, eventId, stored.key),
          finalize: async (stored) => {
            created = await finalizeDeliverableVersion(context.env.DB, {
              eventId, requestId, idempotencyKey: input.idempotencyKey, note: input.note,
              source: source.source, file: storedFileRow(stored, eventId), now: utcSecond(),
            });
          },
        });
      } catch (error) {
        if (error instanceof SpeakerContentCanonicalUploadError) {
          if (!error.semanticMatch) throw new SpeakerContentConflictError();
          return dataResponse(
            context,
            deliverableUploadResponseSchema,
            await deliverableUploadProjection(context.env.DB, eventId, error.canonical),
          );
        }
        const message = constraintMessage(error);
        if (attempt < 2 && /deliverable_versions.*version_number|UNIQUE constraint/i.test(message)) {
          source = await uploadSource(context.env.DB, { eventId, requestId, userId, idempotencyKey: input.idempotencyKey });
          continue;
        }
        throw error;
      }
      if (!created) throw new Error("The deliverable version was not finalized.");
      return dataResponse(
        context,
        deliverableUploadResponseSchema,
        await deliverableUploadProjection(context.env.DB, eventId, created),
      );
    }
    throw new SpeakerContentConflictError();
  } catch (error) {
    return uploadError(context, error);
  }
}

function serviceError(context: RouteContext, error: unknown) {
  if (error instanceof SpeakerReminderAuthorizationError) {
    return errorResponse(context, 403, "EVENT_ROLE_REQUIRED", "An active organizer membership is required to queue a reminder.");
  }
  if (error instanceof SpeakerReminderNotFoundError) {
    return errorResponse(context, 404, "SPEAKER_NOT_FOUND", "The selected speaker does not exist in this event.");
  }
  if (error instanceof SpeakerReminderTemplateNotFoundError) {
    return errorResponse(context, 400, "REMINDER_TEMPLATE_NOT_FOUND", "Choose a reminder template from the active catalog.");
  }
  if (error instanceof SpeakerReminderIdempotencyConflictError) {
    return errorResponse(context, 409, "IDEMPOTENCY_CONFLICT", "This idempotency key already identifies different reminder content.");
  }
  if (error instanceof SpeakerReminderIneligibleError) {
    const response = {
      NO_CONTACT_EMAIL: ["REMINDER_CONTACT_REQUIRED", "Add a valid speaker contact email before queueing a reminder."],
      SPEAKER_ACCESS_UNAVAILABLE: ["REMINDER_ACCESS_UNAVAILABLE", "Link the speaker to a verified event account before queueing portal reminders."],
      SPEAKER_DECLINED: ["REMINDER_DECLINED", "A declined speaker cannot receive readiness reminders."],
      NO_OUTSTANDING_ITEMS: ["NO_REMINDER_NEEDED", "This template has no outstanding items to include for the selected speaker."],
    }[error.reason];
    return errorResponse(context, 409, response[0], response[1]);
  }
  if (error instanceof DeliverablesArchiveLimitError) {
    return errorResponse(
      context,
      409,
      "ARCHIVE_TOO_LARGE",
      "The approved deliverables exceed ZIP32 limits and cannot be exported as one archive.",
    );
  }
  if (error instanceof SpeakerContentNotFoundError) {
    return errorResponse(context, 404, "CONTENT_NOT_FOUND", "The requested speaker content record does not exist.");
  }
  if (error instanceof SpeakerContentApprovalBlockedError) {
    return errorResponse(
      context,
      409,
      "APPROVAL_BLOCKED",
      "Complete every approval requirement before approving this session.",
    );
  }
  if (error instanceof SpeakerContentConflictError) {
    return errorResponse(
      context,
      409,
      "REVISION_CONFLICT",
      "This record changed since it was loaded. Reload it and try again.",
    );
  }
  if (error instanceof SpeakerContentDataIntegrityError) {
    return errorResponse(
      context,
      409,
      "HISTORY_DATA_INTEGRITY",
      "This saved profile version cannot be restored because its data is invalid.",
    );
  }
  if (error instanceof SpeakerContentNotAllowedError) {
    const response = {
      PROFILE_NOT_READY: {
        code: "READINESS_BLOCKED",
        message: "Complete the required speaker information before making this change.",
      },
      TASK_WAIVED: {
        code: "TASK_WAIVED",
        message: "An organizer waived this task. Reopen it before the speaker updates it.",
      },
      NO_CHANGES: {
        code: "NO_CHANGES",
        message: "Change at least one session field before saving.",
      },
      RESTORE_NOT_ALLOWED: {
        code: "RESTORE_NOT_ALLOWED",
        message: "Headshot upload audit entries cannot be restored.",
      },
    }[error.reason];
    return errorResponse(
      context,
      409,
      response.code,
      response.message,
    );
  }
  console.error("Speaker content request failed", {
    requestId: context.get("requestId"),
    error,
  });
  return errorResponse(context, 500, "INTERNAL_ERROR", "The speaker content request could not be completed.");
}

function safely<T>(
  context: RouteContext,
  operation: () => Promise<T>,
  schema: { parse(value: unknown): T },
) {
  return operation()
    .then((value) => dataResponse(context, schema, value))
    .catch((error: unknown) => serviceError(context, error));
}

export function createSpeakerContentHandlers(): Partial<SpeakerContentRouteHandlers> {
  return {
    speakerWorkspace: (context) => safely(
      context,
      () => getSpeakerContentWorkspace(
        context.env.DB,
        context.get("authEventId"),
        context.get("authUserId"),
      ),
      speakerContentWorkspaceResponseSchema,
    ),
    organizerRoster: (context) => safely(
      context,
      () => getOrganizerSpeakerRoster(context.env.DB, context.get("authEventId")),
      organizerSpeakerRosterResponseSchema,
    ),
    createOrganizerSpeaker: (context, value) => safely(
      context,
      () => ingestSpeakerRosterRows(context.env.DB, context.get("authEventId"), [
        { rowNumber: 1, value },
      ]),
      speakerRosterIngestResponseSchema,
    ),
    importOrganizerSpeakers: async (context, { file }) => {
      if (file.size > 512 * 1024) {
        return errorResponse(context, 413, "CSV_TOO_LARGE", "CSV imports are limited to 512 KiB.");
      }
      if (!file.name.toLowerCase().endsWith(".csv")) {
        return errorResponse(context, 400, "CSV_REQUIRED", "Choose a .csv file.");
      }
      return safely(
        context,
        async () => ingestSpeakerRosterRows(
          context.env.DB,
          context.get("authEventId"),
          parseSpeakerRosterCsv(await file.text()),
        ),
        speakerRosterIngestResponseSchema,
      );
    },
    speakerReminderTemplates: (context) => safely(
      context,
      async () => listSpeakerReminderTemplates(),
      speakerReminderTemplateListResponseSchema,
    ),
    enqueueSpeakerReminder: (context, value) => safely(
      context,
      () => enqueueSpeakerReminder(
        context.env.DB,
        context.get("authEventId"),
        context.get("authUserId"),
        value,
        utcSecond(),
      ),
      speakerReminderEnqueueResponseSchema,
    ),
    organizerContent: (context) => safely(
      context,
      () => getOrganizerContent(context.env.DB, context.get("authEventId")),
      organizerContentListResponseSchema,
    ),
    exportOrganizerDeliverables: async (context) => {
      try {
        const store = privateFiles(context);
        const plan = planDeliverablesArchive(await approvedCurrentDeliverables(
          context.env.DB,
          context.get("authEventId"),
        ));
        await verifyDeliverablesArchiveObjects(store, plan);
        const filename = safeAttachmentFilename(
          `${routeParam(context, "eventSlug")}-approved-deliverables.zip`,
        );
        return new Response(streamDeliverablesArchive(store, plan), {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": attachmentContentDisposition(filename),
            "content-length": String(plan.byteSize),
            "content-type": "application/zip",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return serviceError(context, error);
      }
    },
    updateSpeakerProfile: (context, value) => safely(
      context,
      () => updateOwnedSpeakerProfile(context.env.DB, {
        eventId: context.get("authEventId"),
        userId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      speakerProfileResponseSchema,
    ),
    uploadOwnHeadshot: (context, input) => uploadHeadshot(context, input.file, false),
    uploadOrganizerHeadshot: (context, input) => uploadHeadshot(context, input.file, true),
    downloadOwnHeadshot: async (context) => {
      try {
        return await privateFileResponse(context, await headshotFile(context.env.DB, {
          eventId: context.get("authEventId"),
          userId: context.get("authUserId"),
        }), "inline");
      } catch (error) {
        return serviceError(context, error);
      }
    },
    downloadOrganizerHeadshot: async (context) => {
      try {
        return await privateFileResponse(context, await headshotFile(context.env.DB, {
          eventId: context.get("authEventId"),
          speakerId: routeParam(context, "speakerId"),
          organizer: true,
        }), "inline");
      } catch (error) {
        return serviceError(context, error);
      }
    },
    publicHeadshot: (context) => publicHeadshotResponse(context),
    updateOwnTask: (context, value) => safely(
      context,
      () => updateOwnedSpeakerTask(context.env.DB, {
        eventId: context.get("authEventId"),
        userId: context.get("authUserId"),
        taskId: routeParam(context, "taskId"),
        value,
        now: utcSecond(),
      }),
      speakerTaskResponseSchema,
    ),
    uploadDeliverable: (context, input) => uploadDeliverableVersion(context, input),
    downloadSpeakerDeliverable: async (context) => {
      try {
        return await privateFileResponse(context, await authorizedDeliverableFile(context.env.DB, {
          eventId: context.get("authEventId"),
          versionId: routeParam(context, "versionId"),
          userId: context.get("authUserId"),
        }), "attachment");
      } catch (error) {
        return serviceError(context, error);
      }
    },
    downloadOrganizerDeliverable: async (context) => {
      try {
        return await privateFileResponse(context, await authorizedDeliverableFile(context.env.DB, {
          eventId: context.get("authEventId"),
          versionId: routeParam(context, "versionId"),
          organizer: true,
        }), "attachment");
      } catch (error) {
        return serviceError(context, error);
      }
    },
    updateOrganizerTask: (context, value) => safely(
      context,
      () => updateOrganizerSpeakerTask(context.env.DB, {
        eventId: context.get("authEventId"),
        speakerId: routeParam(context, "speakerId"),
        taskId: routeParam(context, "taskId"),
        value,
        now: utcSecond(),
      }),
      speakerTaskResponseSchema,
    ),
    createBulkTasks: (context, value) => safely(
      context,
      () => createBulkSpeakerTasks(context.env.DB, {
        eventId: context.get("authEventId"),
        actorUserId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      organizerSpeakerRosterResponseSchema,
    ),
    updateOrganizerSpeakerProfile: (context, value) => safely(
      context,
      () => updateOrganizerSpeakerProfile(context.env.DB, {
        eventId: context.get("authEventId"),
        speakerId: routeParam(context, "speakerId"),
        actorUserId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      speakerProfileResponseSchema,
    ),
    updateSessionApproval: (context, value) => safely(
      context,
      () => updateSessionApproval(context.env.DB, {
        eventId: context.get("authEventId"),
        sessionId: routeParam(context, "sessionId"),
        value,
        now: utcSecond(),
      }),
      organizerContentListResponseSchema,
    ),
    createDeliverableRequest: (context, value) => safely(
      context,
      () => createDeliverableRequest(context.env.DB, {
        eventId: context.get("authEventId"),
        sessionId: routeParam(context, "sessionId"),
        actorUserId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      deliverableRequestResponseSchema,
    ),
    updateDeliverableRequest: (context, value) => safely(
      context,
      () => updateDeliverableRequest(context.env.DB, {
        eventId: context.get("authEventId"),
        sessionId: routeParam(context, "sessionId"),
        requestId: routeParam(context, "requestId"),
        actorUserId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      deliverableRequestResponseSchema,
    ),
    createContentReview: (context, value) => safely(
      context,
      () => createContentReview(context.env.DB, {
        eventId: context.get("authEventId"),
        sessionId: routeParam(context, "sessionId"),
        actorUserId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      contentReviewResponseSchema,
    ),
    createOrganizerComment: (context, value) => safely(
      context,
      () => createContentComment(context.env.DB, {
        eventId: context.get("authEventId"),
        sessionId: routeParam(context, "sessionId"),
        authorUserId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      contentCommentResponseSchema,
    ),
    createSpeakerComment: async (context, value) => {
      try {
        const eventId = context.get("authEventId");
        const sessionId = routeParam(context, "sessionId");
        const speakerId = await speakerIdForUserSession(
          context.env.DB,
          eventId,
          context.get("authUserId"),
          sessionId,
        );
        if (!speakerId) throw new SpeakerContentNotFoundError();
        return dataResponse(context, contentCommentResponseSchema, await createContentComment(
          context.env.DB,
          { eventId, sessionId, authorSpeakerId: speakerId, value, now: utcSecond() },
        ));
      } catch (error) {
        return serviceError(context, error);
      }
    },
    updateSessionContent: (context, value) => safely(
      context,
      () => updateSessionContent(context.env.DB, {
        eventId: context.get("authEventId"),
        sessionId: routeParam(context, "sessionId"),
        actorUserId: context.get("authUserId"),
        value,
        now: utcSecond(),
      }),
      sessionContentHistoryResponseSchema,
    ),
    restoreSessionContent: (context) => safely(
      context,
      () => restoreSessionContent(context.env.DB, {
        eventId: context.get("authEventId"),
        sessionId: routeParam(context, "sessionId"),
        historyId: routeParam(context, "historyId"),
        actorUserId: context.get("authUserId"),
        now: utcSecond(),
      }),
      sessionContentHistoryResponseSchema,
    ),
    restoreSpeakerProfile: (context) => safely(
      context,
      () => restoreSpeakerProfile(context.env.DB, {
        eventId: context.get("authEventId"),
        speakerId: routeParam(context, "speakerId"),
        historyId: routeParam(context, "historyId"),
        actorUserId: context.get("authUserId"),
        now: utcSecond(),
      }),
      speakerProfileResponseSchema,
    ),
    updateSpeakerVisibility: (context, value) => safely(
      context,
      () => updateSpeakerVisibility(context.env.DB, {
        eventId: context.get("authEventId"),
        speakerId: routeParam(context, "speakerId"),
        value,
        now: utcSecond(),
      }),
      speakerProfileResponseSchema,
    ),
    updateSpeakerWorkflow: (context, value) => safely(
      context,
      () => updateSpeakerWorkflow(context.env.DB, {
        eventId: context.get("authEventId"),
        speakerId: routeParam(context, "speakerId"),
        value,
        now: utcSecond(),
      }),
      speakerProfileResponseSchema,
    ),
  };
}
