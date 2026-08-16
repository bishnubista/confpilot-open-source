import {
  cfpConfigUpdateSchema,
  cfpFieldSchema,
  proposalCoPresenterListResponseSchema,
  proposalCoPresenterWriteSchema,
  proposalDraftCreateSchema,
  proposalDraftUpdateSchema,
  speakerRegistrationSchema,
  SESSION_FORMAT_DURATIONS,
  sessionFormatSchema,
  type CfpField,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { issueSession, sessionProjection } from "../../auth-routes";
import { getAuthenticatedSession, hashToken, requireEventRole } from "../../auth";
import { errorResponse } from "../../http";
import {
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  derivePasswordHash,
  randomPasswordSalt,
} from "../../password";
import type { AppBindings } from "../../types";
import { unownedSpeakerByEmail } from "../../speaker-identity";
import { createTurnstileCaptchaVerifier } from "../../runtime/captcha-verifier";
import { requestSource } from "../../runtime/client-ip";

interface CfpConfigRow {
  eventId: string;
  eventSlug: string;
  eventName: string;
  tagline: string;
  location: string;
  description: string;
  startsOn: string;
  endsOn: string;
  status: "draft" | "published";
  opensAt: string;
  closesAt: string;
  confirmationMessage: string;
  revision: number;
}

interface CfpFieldRow {
  key: string;
  section: "session" | "speaker";
  type: "short_text" | "long_text" | "dropdown";
  label: string;
  helpText: string;
  required: number;
  optionsJson: string;
  sortOrder: number;
  showWhenFieldKey: string | null;
  showWhenValue: string | null;
}

interface ProposalRow {
  id: string;
  publicId: string;
  title: string;
  status: "draft" | "submitted" | "in_review" | "decided";
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  clientDraftKey: string | null;
  decision?: "accept" | "reject" | "waitlist" | null;
  ownerName?: string;
  ownerEmail?: string;
}

interface AnswerRow { fieldKey: string; value: string }
interface SpeakerRow { id: string }
interface ProposalParticipantRow {
  id: string;
  name: string;
  email: string | null;
  role: "primary" | "co_presenter";
}
interface ValidationIssue { field: string; message: string }

function parseOptions(raw: string): CfpField["options"] {
  try {
    const result = cfpFieldSchema.shape.options.safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
}

function uniqueMutationTimestamp() {
  const suffix = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  return new Date().toISOString().replace(/(\.\d{3})Z$/, `$1${suffix}Z`);
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

async function configBySlug(context: Context<AppBindings>, publishedOnly: boolean) {
  return context.env.DB.prepare(
    `SELECT
      event.id AS eventId,
      event.slug AS eventSlug,
      event.name AS eventName,
      event.tagline AS tagline,
      event.location AS location,
      event.description AS description,
      event.starts_on AS startsOn,
      event.ends_on AS endsOn,
      config.status AS status,
      config.opens_at AS opensAt,
      config.closes_at AS closesAt,
      config.confirmation_message AS confirmationMessage,
      config.revision AS revision
    FROM events AS event
    INNER JOIN cfp_configs AS config ON config.event_id = event.id
    WHERE event.slug = ?${publishedOnly ? " AND config.status = 'published' AND event.status = 'published'" : ""}
    LIMIT 1`,
  ).bind(context.req.param("eventSlug")).first<CfpConfigRow>();
}

async function configByEventId(context: Context<AppBindings>) {
  return context.env.DB.prepare(
    `SELECT
      event.id AS eventId,
      event.slug AS eventSlug,
      event.name AS eventName,
      event.tagline AS tagline,
      event.location AS location,
      event.description AS description,
      event.starts_on AS startsOn,
      event.ends_on AS endsOn,
      config.status AS status,
      config.opens_at AS opensAt,
      config.closes_at AS closesAt,
      config.confirmation_message AS confirmationMessage,
      config.revision AS revision
    FROM events AS event
    INNER JOIN cfp_configs AS config ON config.event_id = event.id
    WHERE event.id = ?
    LIMIT 1`,
  ).bind(context.get("authEventId")).first<CfpConfigRow>();
}

async function fieldsForEvent(context: Context<AppBindings>, eventId: string, activeOnly = true) {
  const { results } = await context.env.DB.prepare(
    `SELECT
      field_key AS key,
      section,
      field_type AS type,
      label,
      help_text AS helpText,
      required,
      options_json AS optionsJson,
      sort_order AS sortOrder,
      show_when_field_key AS showWhenFieldKey,
      show_when_value AS showWhenValue
    FROM cfp_fields
    WHERE event_id = ?${activeOnly ? " AND active = 1" : ""}
    ORDER BY sort_order ASC, field_key ASC`,
  ).bind(eventId).all<CfpFieldRow>();
  return results.map((field): CfpField => ({
    key: field.key,
    section: field.section,
    type: field.type,
    label: field.label,
    helpText: field.helpText,
    required: field.required === 1,
    options: parseOptions(field.optionsJson),
    sortOrder: field.sortOrder,
    showWhen: field.showWhenFieldKey && field.showWhenValue
      ? { fieldKey: field.showWhenFieldKey, equals: field.showWhenValue }
      : null,
  }));
}

function cfpState(config: CfpConfigRow) {
  const now = Date.now();
  if (now < Date.parse(config.opensAt)) return "upcoming" as const;
  if (now > Date.parse(config.closesAt)) return "closed" as const;
  return "open" as const;
}

const inaccurateStockConfirmationMessage = "Thanks for sharing your proposal. You can edit it until the CFP closes.";
const truthfulStockConfirmationMessage = "Thanks for sharing your proposal. You can view its status from this account.";

function truthfulConfirmationMessage(message: string) {
  return message === inaccurateStockConfirmationMessage ? truthfulStockConfirmationMessage : message;
}

function configProjection(config: CfpConfigRow, fields: CfpField[], context: Context<AppBindings>) {
  return {
    event: {
      slug: config.eventSlug,
      name: config.eventName,
      tagline: config.tagline,
      location: config.location,
      description: config.description,
      startsOn: config.startsOn,
      endsOn: config.endsOn,
    },
    status: config.status,
    state: cfpState(config),
    opensAt: config.opensAt,
    closesAt: config.closesAt,
    confirmationMessage: truthfulConfirmationMessage(config.confirmationMessage),
    turnstile: createTurnstileCaptchaVerifier(context.env)
      .publicConfig(new URL(context.req.url).hostname),
    revision: config.revision,
    fields,
  };
}

function ensureOpen(context: Context<AppBindings>, config: CfpConfigRow | null) {
  if (!config) return errorResponse(context, 404, "CFP_NOT_FOUND", "The requested call for proposals does not exist.");
  if (config.status !== "published" || cfpState(config) !== "open") {
    return errorResponse(context, 409, "CFP_CLOSED", "This call for proposals is not accepting changes.");
  }
  return null;
}

function validateValues(fields: CfpField[], values: Record<string, string>, requireComplete: boolean) {
  const issues: ValidationIssue[] = [];
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) issues.push({ field: key, message: "This field is not part of the current form." });
  }
  for (const field of fields) {
    const visible = !field.showWhen || valueFor(values, field.showWhen.fieldKey) === field.showWhen.equals;
    const value = valueFor(values, field.key);
    if (!visible) {
      if (value.trim()) issues.push({ field: field.key, message: "This field is not currently applicable." });
      continue;
    }
    if (requireComplete && field.required && !value.trim()) {
      issues.push({ field: field.key, message: "This field is required." });
    }
    if (value && field.type === "dropdown" && !field.options.some((option) => option.value === value)) {
      issues.push({ field: field.key, message: "Choose one of the configured options." });
    }
  }
  return issues;
}

function valueFor(values: Record<string, string>, key: string) {
  return Object.hasOwn(values, key) && typeof values[key] === "string" ? values[key] : "";
}

function formatDetails(fields: CfpField[], values: Record<string, string>) {
  const requested = valueFor(values, "format");
  const field = fields.find((candidate) => candidate.key === "format");
  const validOptions = (field?.options ?? []).filter((option) => {
    const format = sessionFormatSchema.safeParse(option.value);
    return format.success && option.durationMinutes === SESSION_FORMAT_DURATIONS[format.data];
  });
  const option = validOptions.find((candidate) => candidate.value === requested) ?? validOptions[0];
  return {
    format: option?.value ?? "talk",
    durationMinutes: option?.durationMinutes ?? SESSION_FORMAT_DURATIONS.talk,
  };
}

function safeSlug(value: string) {
  const base = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-+$/g, "");
  return base || "draft";
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "SP";
}

async function proposalAnswers(context: Context<AppBindings>, eventId: string, proposalId: string): Promise<Record<string, string>> {
  const { results } = await context.env.DB.prepare(
    `SELECT answer.field_key AS fieldKey, answer.value
    FROM proposal_answers AS answer
    INNER JOIN cfp_fields AS field
      ON field.event_id = answer.event_id AND field.field_key = answer.field_key
    WHERE answer.event_id = ? AND answer.proposal_id = ? AND field.active = 1
    ORDER BY answer.field_key ASC`,
  ).bind(eventId, proposalId).all<AnswerRow>();
  return Object.fromEntries(results.map((answer) => [answer.fieldKey, answer.value]));
}

async function proposalParticipants(
  context: Context<AppBindings>,
  eventId: string,
  proposalId: string,
) {
  const { results } = await context.env.DB.prepare(
    `SELECT presenter.id, speaker.name,
      NULLIF(lower(trim(speaker.contact_email)), '') AS email,
      presenter.role
    FROM proposal_presenters AS presenter
    INNER JOIN speakers AS speaker
      ON speaker.id = presenter.speaker_id AND speaker.event_id = presenter.event_id
    WHERE presenter.event_id = ? AND presenter.proposal_id = ?
    ORDER BY presenter.role = 'primary' DESC, lower(speaker.name) ASC, presenter.id ASC`,
  ).bind(eventId, proposalId).all<ProposalParticipantRow>();
  return proposalCoPresenterListResponseSchema.parse({ participants: results });
}

async function proposalProjection(
  context: Context<AppBindings>,
  eventId: string,
  proposal: ProposalRow,
  suppliedValues?: Record<string, string>,
) {
  const decision = proposal.decision === undefined
    ? await context.env.DB.prepare(
      "SELECT decision FROM decisions WHERE event_id = ? AND proposal_id = ? LIMIT 1",
    ).bind(eventId, proposal.id).first<"accept" | "reject" | "waitlist">("decision")
    : proposal.decision;
  return {
    id: proposal.id,
    publicId: proposal.publicId,
    status: proposal.status,
    submittedAt: proposal.submittedAt,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    clientDraftKey: proposal.clientDraftKey,
    decision: decision ?? null,
    ...(proposal.ownerName ? { owner: { name: proposal.ownerName, email: proposal.ownerEmail } } : {}),
    values: suppliedValues ?? await proposalAnswers(context, eventId, proposal.id),
  };
}

/**
 * Answers for a set of proposals, looked up in chunks.
 *
 * The id list becomes one bound parameter each, and a statement may carry at
 * most `MAX_BOUND_PARAMETERS`. The organizer listing caps its page at 90 so it
 * stays under that, but the speaker's own listing is unbounded — a speaker with
 * a hundred proposals in one event would otherwise exceed the limit and fail
 * their entire proposal list. Chunking at the same size the roster and
 * communication lookups use keeps room for the other bindings in the statement.
 */
const ANSWER_LOOKUP_CHUNK_SIZE = 90;

async function answersForProposals(context: Context<AppBindings>, eventId: string, proposalIds: string[]) {
  const grouped = new Map<string, Record<string, string>>();
  for (let offset = 0; offset < proposalIds.length; offset += ANSWER_LOOKUP_CHUNK_SIZE) {
    const chunk = proposalIds.slice(offset, offset + ANSWER_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await context.env.DB.prepare(
      `SELECT answer.proposal_id AS proposalId, answer.field_key AS fieldKey, answer.value
      FROM proposal_answers AS answer
      INNER JOIN cfp_fields AS field
        ON field.event_id = answer.event_id AND field.field_key = answer.field_key
      WHERE answer.event_id = ? AND field.active = 1 AND answer.proposal_id IN (${placeholders})
      ORDER BY answer.proposal_id ASC, answer.field_key ASC`,
    ).bind(eventId, ...chunk).all<AnswerRow & { proposalId: string }>();
    for (const answer of results) {
      const values = grouped.get(answer.proposalId) ?? Object.create(null) as Record<string, string>;
      values[answer.fieldKey] = answer.value;
      grouped.set(answer.proposalId, values);
    }
  }
  return grouped;
}

async function ownedProposal(context: Context<AppBindings>) {
  return context.env.DB.prepare(
    `SELECT
      id,
      public_id AS publicId,
      title,
      status,
      submitted_at AS submittedAt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      client_draft_key AS clientDraftKey
      ,(SELECT decision FROM decisions WHERE event_id = ? AND proposal_id = proposals.id LIMIT 1) AS decision
    FROM proposals
    WHERE id = ? AND event_id = ? AND owner_user_id = ?
    LIMIT 1`,
  ).bind(
    context.get("authEventId"),
    context.req.param("proposalId"),
    context.get("authEventId"),
    context.get("authUserId"),
  ).first<ProposalRow>();
}

function rateLimited(context: Context<AppBindings>) {
  context.header("retry-after", "60");
  return errorResponse(context, 429, "REGISTRATION_RATE_LIMITED", "Too many registration attempts. Wait a minute and try again.");
}

export function createCfpRoutes() {
  const routes = new Hono<AppBindings>();

  routes.get("/cfp/:eventSlug", async (context) => {
    const config = await configBySlug(context, true);
    if (!config) return errorResponse(context, 404, "CFP_NOT_FOUND", "The requested call for proposals does not exist.");
    context.header("cache-control", "public, no-cache");
    return context.json({
      data: configProjection(config, await fieldsForEvent(context, config.eventId), context),
      requestId: context.get("requestId"),
    });
  });

  routes.post("/cfp/:eventSlug/register", async (context) => {
    const source = requestSource(context);
    const sourceLimit = await context.env.LOGIN_SOURCE_RATE_LIMITER.limit({
      key: await hashToken(`register:source:${source}`),
    });
    if (!sourceLimit.success) return rateLimited(context);

    const input = await parseJson(context, speakerRegistrationSchema);
    if (input instanceof Response) return input;
    const accountLimit = await context.env.LOGIN_ACCOUNT_RATE_LIMITER.limit({
      key: await hashToken(`register:account:${input.email}`),
    });
    if (!accountLimit.success) return rateLimited(context);

    const config = await configBySlug(context, true);
    const closed = ensureOpen(context, config);
    if (closed) return closed;

    const verification = await createTurnstileCaptchaVerifier(context.env).verify(
      input.turnstileToken,
      {
        remoteIp: source === "unattributed" ? undefined : source,
        requestHostname: new URL(context.req.url).hostname,
      },
    );
    if (!verification.ok) {
      if (verification.reason === "unavailable" || verification.reason === "unconfigured") {
        return errorResponse(context, 503, "REGISTRATION_UNAVAILABLE", "Account creation is temporarily unavailable. Try again shortly.");
      }
      return errorResponse(context, 400, "TURNSTILE_INVALID", "Complete the verification and try again.");
    }

    const salt = randomPasswordSalt();
    let hash: string;
    try {
      hash = await derivePasswordHash(input.password, salt, PASSWORD_ITERATIONS);
    } catch {
      return errorResponse(context, 503, "REGISTRATION_UNAVAILABLE", "Account creation is temporarily unavailable. Try again shortly.");
    }
    const duplicate = await context.env.DB.prepare(
      "SELECT id FROM users WHERE lower(trim(email)) = ? LIMIT 1",
    ).bind(input.email).first<{ id: string }>();
    if (duplicate) return errorResponse(context, 409, "REGISTRATION_CONFLICT", "This speaker account could not be created with the submitted details.");

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const speakerId = crypto.randomUUID();
    const suffix = speakerId.slice(0, 8);
    const unowned = await unownedSpeakerByEmail(context.env.DB, config!.eventId, input.email);
    if (unowned) {
      return errorResponse(
        context,
        409,
        "REGISTRATION_CONFLICT",
        "This speaker account could not be created with the submitted details.",
      );
    }
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
        ).bind(userId, input.email, input.displayName, now),
        context.env.DB.prepare(
          `INSERT INTO user_credentials (
            user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(userId, salt, hash, PASSWORD_ALGORITHM, PASSWORD_ITERATIONS, now, now),
        context.env.DB.prepare(
          `INSERT INTO event_memberships (id, event_id, user_id, role, created_at)
          VALUES (?, ?, ?, 'speaker', ?)`,
        ).bind(crypto.randomUUID(), config!.eventId, userId, now),
        context.env.DB.prepare(
          `INSERT INTO speakers (
            id, event_id, user_id, slug, name, title, company, bio, contact_email,
            headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'incomplete', 'missing', 'private')`,
        ).bind(
          speakerId,
          config!.eventId,
          userId,
          `${safeSlug(input.displayName)}-${suffix}`,
          input.displayName,
          input.title,
          input.company,
          input.bio,
          input.email,
          initials(input.displayName),
        ),
      ]);
    } catch (error) {
      const conflict = await context.env.DB.prepare(
        "SELECT 1 AS found FROM users WHERE lower(trim(email)) = ? LIMIT 1",
      ).bind(input.email).first<{ found: number }>();
      const blockedClaim = await unownedSpeakerByEmail(context.env.DB, config!.eventId, input.email);
      if (conflict || blockedClaim) {
        return errorResponse(context, 409, "REGISTRATION_CONFLICT", "This speaker account could not be created with the submitted details.");
      }
      throw error;
    }
    await issueSession(context, userId);
    return context.json({
      data: await sessionProjection(context, {
        userId,
        email: input.email,
        displayName: input.displayName,
      }),
      requestId: context.get("requestId"),
    }, 201);
  });

  routes.post("/cfp/:eventSlug/join", async (context) => {
    const session = await getAuthenticatedSession(context);
    if (!session) return errorResponse(context, 401, "UNAUTHENTICATED", "Sign in to join this call for proposals.");
    const config = await configBySlug(context, true);
    const closed = ensureOpen(context, config);
    if (closed) return closed;
    const speakerMembership = await context.env.DB.prepare(
      "SELECT 1 AS found FROM event_memberships WHERE event_id = ? AND user_id = ? AND role = 'speaker' LIMIT 1",
    ).bind(config!.eventId, session.userId).first<{ found: number }>();
    const speakerId = crypto.randomUUID();
    const now = new Date().toISOString();
    const existingSpeaker = await context.env.DB.prepare(
      "SELECT id FROM speakers WHERE event_id = ? AND user_id = ? LIMIT 1",
    ).bind(config!.eventId, session.userId).first<{ id: string }>();
    const unowned = existingSpeaker
      ? null
      : await unownedSpeakerByEmail(context.env.DB, config!.eventId, session.email.toLowerCase().trim());
    if (unowned) {
      return errorResponse(
        context,
        409,
        "SPEAKER_CLAIM_REQUIRES_VERIFICATION",
        "This organizer-created speaker profile requires a verified claim invitation. Ask an organizer to send the claim, then accept it before submitting.",
      );
    }
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          "INSERT OR IGNORE INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'speaker', ?)",
        ).bind(crypto.randomUUID(), config!.eventId, session.userId, now),
        ...(existingSpeaker ? [] : [context.env.DB.prepare(
          `INSERT INTO speakers (
            id, event_id, user_id, slug, name, title, company, bio, contact_email,
            headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
          )
          SELECT ?, ?, ?, ?, ?, '', '', '', ?, NULL, ?, 'incomplete', 'missing', 'private'
          WHERE EXISTS (
            SELECT 1 FROM event_memberships
            WHERE event_id = ? AND user_id = ? AND role = 'speaker'
          )`,
        ).bind(
          speakerId,
          config!.eventId,
          session.userId,
          `${safeSlug(session.displayName)}-${speakerId.slice(0, 8)}`,
          session.displayName,
          session.email,
          initials(session.displayName),
          config!.eventId,
          session.userId,
        ),
        ]),
      ]);
    } catch (error) {
      const racedSpeaker = await context.env.DB.prepare(
        "SELECT id FROM speakers WHERE event_id = ? AND user_id = ? LIMIT 1",
      ).bind(config!.eventId, session.userId).first<{ id: string }>();
      if (!racedSpeaker) {
        const blockedClaim = await unownedSpeakerByEmail(
          context.env.DB,
          config!.eventId,
          session.email.toLowerCase().trim(),
        );
        if (blockedClaim) {
          return errorResponse(
            context,
            409,
            "SPEAKER_CLAIM_REQUIRES_VERIFICATION",
            "This organizer-created speaker profile requires a verified claim invitation. Ask an organizer to send the claim, then accept it before submitting.",
          );
        }
        const emailCollision = await context.env.DB.prepare(
          "SELECT 1 AS found FROM speakers WHERE event_id = ? AND lower(trim(contact_email)) = ? LIMIT 1",
        ).bind(config!.eventId, session.email.toLowerCase().trim()).first<{ found: number }>();
        if (emailCollision) {
          return errorResponse(
            context,
            409,
            "SPEAKER_EMAIL_CONFLICT",
            "Another speaker profile already uses this account email. Ask an organizer to correct the roster before joining.",
          );
        }
        throw error;
      }
      await context.env.DB.prepare(
        "INSERT OR IGNORE INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'speaker', ?)",
      ).bind(crypto.randomUUID(), config!.eventId, session.userId, now).run();
    }
    const joinedMembership = speakerMembership ?? await context.env.DB.prepare(
      "SELECT 1 AS found FROM event_memberships WHERE event_id = ? AND user_id = ? AND role = 'speaker' LIMIT 1",
    ).bind(config!.eventId, session.userId).first<{ found: number }>();
    if (!joinedMembership) {
      return errorResponse(context, 409, "MEMBERSHIP_CONFLICT", "Speaker access could not be established for this event.");
    }
    return context.json({
      data: await sessionProjection(context, session),
      requestId: context.get("requestId"),
    });
  });

  routes.use("/events/:eventSlug/cfp", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/*", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/cfp", async (context) => {
    const config = await configByEventId(context);
    if (!config) return errorResponse(context, 404, "CFP_NOT_FOUND", "The requested call for proposals does not exist.");
    return context.json({ data: configProjection(config, await fieldsForEvent(context, config.eventId), context), requestId: context.get("requestId") });
  });

  routes.put("/events/:eventSlug/cfp", async (context) => {
    const input = await parseJson(context, cfpConfigUpdateSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const mutationTimestamp = uniqueMutationTimestamp();
    const existing = await configByEventId(context);
    if (!existing) return errorResponse(context, 404, "CFP_NOT_FOUND", "The requested call for proposals does not exist.");
    const strandedDay = await context.env.DB.prepare(
      "SELECT date FROM event_days WHERE event_id = ? AND (date < ? OR date > ?) ORDER BY date LIMIT 1",
    ).bind(eventId, input.event.startsOn, input.event.endsOn).first<string>("date");
    if (strandedDay) {
      return errorResponse(
        context,
        400,
        "AGENDA_DATE_CONFLICT",
        "Move or remove agenda days outside the new event dates before saving.",
        [{ field: "event.endsOn", message: `Agenda day ${strandedDay} falls outside the new event dates.` }],
      );
    }
    const nextRevision = input.expectedRevision + 1;
    const mutationGuard = `EXISTS (
      SELECT 1 FROM cfp_configs AS guarded
      WHERE guarded.event_id = ? AND guarded.revision = ? AND guarded.updated_at = ?
    )`;
    const statements = [
      context.env.DB.prepare(
        `UPDATE cfp_configs SET status = ?, opens_at = ?, closes_at = ?, confirmation_message = ?,
          revision = revision + 1, updated_at = ? WHERE event_id = ? AND revision = ?`,
      ).bind(
        input.status,
        input.opensAt,
        input.closesAt,
        truthfulConfirmationMessage(input.confirmationMessage),
        mutationTimestamp,
        eventId,
        input.expectedRevision,
      ),
      context.env.DB.prepare(
        `UPDATE events SET name = ?, tagline = ?, location = ?, description = ?, starts_on = ?, ends_on = ?, cfp_deadline = ?
        WHERE id = ? AND ${mutationGuard}`,
      ).bind(
        input.event.name,
        input.event.tagline,
        input.event.location,
        input.event.description,
        input.event.startsOn,
        input.event.endsOn,
        input.closesAt,
        eventId,
        eventId,
        nextRevision,
        mutationTimestamp,
      ),
      context.env.DB.prepare(
        `UPDATE cfp_fields SET active = 0 WHERE event_id = ? AND ${mutationGuard}`,
      ).bind(eventId, eventId, nextRevision, mutationTimestamp),
      ...input.fields.map((field) => context.env.DB.prepare(
        `INSERT INTO cfp_fields (
          id, event_id, field_key, section, field_type, label, help_text, required,
          options_json, sort_order, show_when_field_key, show_when_value, active
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
        WHERE ${mutationGuard}
        ON CONFLICT(event_id, field_key) DO UPDATE SET
          section = excluded.section,
          field_type = excluded.field_type,
          label = excluded.label,
          help_text = excluded.help_text,
          required = excluded.required,
          options_json = excluded.options_json,
          sort_order = excluded.sort_order,
          show_when_field_key = excluded.show_when_field_key,
          show_when_value = excluded.show_when_value,
          active = 1`,
      ).bind(
        crypto.randomUUID(), eventId, field.key, field.section, field.type, field.label,
        field.helpText, field.required ? 1 : 0, JSON.stringify(field.options), field.sortOrder,
        field.showWhen?.fieldKey ?? null, field.showWhen?.equals ?? null,
        eventId, nextRevision, mutationTimestamp,
      )),
    ];
    const [configUpdate] = await context.env.DB.batch(statements);
    if ((configUpdate.meta.changes ?? 0) !== 1) {
      return errorResponse(
        context,
        409,
        "CFP_REVISION_CONFLICT",
        "This submission form changed in another session. Reload the latest version before saving again.",
      );
    }
    const config = await configByEventId(context);
    return context.json({ data: configProjection(config!, await fieldsForEvent(context, eventId), context), requestId: context.get("requestId") });
  });

  routes.get("/events/:eventSlug/cfp/proposals", async (context) => {
    const eventId = context.get("authEventId");
    const requestedLimit = Number.parseInt(context.req.query("limit") ?? "50", 10);
    const requestedOffset = Number.parseInt(context.req.query("offset") ?? "0", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 90) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.min(Math.max(requestedOffset, 0), 10_000) : 0;
    const { results } = await context.env.DB.prepare(
      `SELECT
        proposal.id,
        proposal.public_id AS publicId,
        proposal.title,
        proposal.status,
        proposal.submitted_at AS submittedAt,
        proposal.created_at AS createdAt,
        proposal.updated_at AS updatedAt,
        proposal.client_draft_key AS clientDraftKey,
        decision.decision AS decision,
        user.display_name AS ownerName,
        lower(trim(user.email)) AS ownerEmail
      FROM proposals AS proposal
      LEFT JOIN users AS user ON user.id = proposal.owner_user_id
      LEFT JOIN decisions AS decision
        ON decision.event_id = proposal.event_id AND decision.proposal_id = proposal.id
      WHERE proposal.event_id = ?
      ORDER BY proposal.created_at ASC, proposal.id ASC
      LIMIT ? OFFSET ?`,
    ).bind(eventId, limit + 1, offset).all<ProposalRow>();
    const page = results.slice(0, limit);
    const answers = await answersForProposals(context, eventId, page.map((proposal) => proposal.id));
    return context.json({
      data: {
        proposals: await Promise.all(page.map((proposal) => proposalProjection(context, eventId, proposal, answers.get(proposal.id) ?? {}))),
        page: { limit, offset, hasMore: results.length > limit },
      },
      requestId: context.get("requestId"),
    });
  });

  routes.use("/events/:eventSlug/proposals", requireEventRole("speaker"));
  routes.use("/events/:eventSlug/proposals/*", requireEventRole("speaker"));

  routes.get("/events/:eventSlug/proposals", async (context) => {
    const eventId = context.get("authEventId");
    const { results } = await context.env.DB.prepare(
      `SELECT proposal.id, proposal.public_id AS publicId, proposal.title, proposal.status,
        proposal.submitted_at AS submittedAt, proposal.created_at AS createdAt,
        proposal.updated_at AS updatedAt, proposal.client_draft_key AS clientDraftKey,
        decision.decision AS decision
      FROM proposals AS proposal
      LEFT JOIN decisions AS decision
        ON decision.event_id = proposal.event_id AND decision.proposal_id = proposal.id
      WHERE proposal.event_id = ? AND proposal.owner_user_id = ?
      ORDER BY proposal.created_at ASC, proposal.id ASC`,
    ).bind(eventId, context.get("authUserId")).all<ProposalRow>();
    const answers = await answersForProposals(context, eventId, results.map((proposal) => proposal.id));
    return context.json({
      data: {
        proposals: await Promise.all(results.map((proposal) =>
          proposalProjection(context, eventId, proposal, answers.get(proposal.id) ?? {}),
        )),
      },
      requestId: context.get("requestId"),
    });
  });

  routes.post("/events/:eventSlug/proposals", async (context) => {
    const input = await parseJson(context, proposalDraftCreateSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const existing = await context.env.DB.prepare(
      `SELECT id, public_id AS publicId, title, status, submitted_at AS submittedAt,
        created_at AS createdAt, updated_at AS updatedAt, client_draft_key AS clientDraftKey
      FROM proposals
      WHERE event_id = ? AND owner_user_id = ? AND client_draft_key = ? LIMIT 1`,
    ).bind(eventId, context.get("authUserId"), input.clientDraftKey).first<ProposalRow>();
    if (existing) return context.json({ data: await proposalProjection(context, eventId, existing), requestId: context.get("requestId") });

    const config = await configByEventId(context);
    const closed = ensureOpen(context, config);
    if (closed) return closed;
    const fields = await fieldsForEvent(context, eventId);
    const issues = validateValues(fields, input.values, false);
    if (issues.length) return errorResponse(context, 400, "PROPOSAL_INVALID", "Check the proposal fields and try again.", issues);
    const speaker = await context.env.DB.prepare(
      "SELECT id FROM speakers WHERE event_id = ? AND user_id = ? LIMIT 1",
    ).bind(eventId, context.get("authUserId")).first<SpeakerRow>();
    if (!speaker) return errorResponse(context, 409, "SPEAKER_PROFILE_REQUIRED", "Create a speaker profile before starting a proposal.");
    const proposalCount = await context.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM proposals WHERE event_id = ? AND owner_user_id = ?",
    ).bind(eventId, context.get("authUserId")).first<{ count: number }>();
    if ((proposalCount?.count ?? 0) >= 20) {
      return errorResponse(context, 409, "PROPOSAL_LIMIT_REACHED", "This account has reached the proposal limit for this event.");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const title = valueFor(input.values, "title").trim() || "Untitled draft";
    const details = formatDetails(fields, input.values);
    const statements = [
      context.env.DB.prepare(
        `INSERT INTO proposals (
          id, event_id, public_id, slug, title, abstract, track, format, duration_minutes,
          status, submitted_at, created_at, updated_at, owner_user_id, client_draft_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?)`,
      ).bind(
        id, eventId, `ABS-${id.replaceAll("-", "").slice(0, 16).toUpperCase()}`, `${safeSlug(title)}-${id}`,
        title, valueFor(input.values, "abstract"), valueFor(input.values, "track"), details.format,
        details.durationMinutes, now, now, context.get("authUserId"), input.clientDraftKey,
      ),
      context.env.DB.prepare(
        "INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role) VALUES (?, ?, ?, ?, 'primary')",
      ).bind(crypto.randomUUID(), eventId, id, speaker.id),
      ...Object.entries(input.values).map(([key, value]) => context.env.DB.prepare(
        `INSERT INTO proposal_answers (id, event_id, proposal_id, field_key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), eventId, id, key, value, now, now)),
    ];
    if (Object.hasOwn(input.values, "speaker_bio")) {
      const speakerBio = valueFor(input.values, "speaker_bio");
      statements.push(
        context.env.DB.prepare(
          `UPDATE speakers
          SET bio = ?, revision = revision + 1,
            updated_at = CASE
              WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
              ELSE ?
            END
          WHERE id = ? AND event_id = ? AND bio != ?`,
        ).bind(speakerBio, now, now, speaker.id, eventId, speakerBio),
      );
    }
    try {
      await context.env.DB.batch(statements);
    } catch (error) {
      const raced = await context.env.DB.prepare(
        `SELECT id, public_id AS publicId, title, status, submitted_at AS submittedAt,
          created_at AS createdAt, updated_at AS updatedAt, client_draft_key AS clientDraftKey
        FROM proposals
        WHERE event_id = ? AND owner_user_id = ? AND client_draft_key = ? LIMIT 1`,
      ).bind(eventId, context.get("authUserId"), input.clientDraftKey).first<ProposalRow>();
      if (raced) {
        return context.json({ data: await proposalProjection(context, eventId, raced), requestId: context.get("requestId") });
      }
      throw error;
    }
    const proposal = await context.env.DB.prepare(
      `SELECT id, public_id AS publicId, title, status, submitted_at AS submittedAt,
        created_at AS createdAt, updated_at AS updatedAt, client_draft_key AS clientDraftKey
      FROM proposals WHERE id = ? AND event_id = ? AND owner_user_id = ? LIMIT 1`,
    ).bind(id, eventId, context.get("authUserId")).first<ProposalRow>();
    return context.json({ data: await proposalProjection(context, eventId, proposal!), requestId: context.get("requestId") }, 201);
  });

  routes.get("/events/:eventSlug/proposals/:proposalId", async (context) => {
    const proposal = await ownedProposal(context);
    if (!proposal) return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    return context.json({ data: await proposalProjection(context, context.get("authEventId"), proposal), requestId: context.get("requestId") });
  });

  routes.get("/events/:eventSlug/proposals/:proposalId/participants", async (context) => {
    const proposal = await ownedProposal(context);
    if (!proposal) return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    return context.json({
      data: await proposalParticipants(context, context.get("authEventId"), proposal.id),
      requestId: context.get("requestId"),
    });
  });

  routes.post("/events/:eventSlug/proposals/:proposalId/co-presenters", async (context) => {
    const input = await parseJson(context, proposalCoPresenterWriteSchema);
    if (input instanceof Response) return input;
    const proposal = await ownedProposal(context);
    if (!proposal) return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    if (!["draft", "submitted"].includes(proposal.status)) {
      return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal's participants can no longer be edited.");
    }
    const config = await configByEventId(context);
    const closed = ensureOpen(context, config);
    if (closed) return closed;

    const eventId = context.get("authEventId");
    const normalizedEmail = input.email?.trim().toLowerCase() || null;
    const existingSpeaker = normalizedEmail
      ? await context.env.DB.prepare(
        `SELECT id FROM speakers
        WHERE event_id = ? AND lower(trim(contact_email)) = ? LIMIT 1`,
      ).bind(eventId, normalizedEmail).first<SpeakerRow>()
      : await context.env.DB.prepare(
        `SELECT id FROM speakers
        WHERE event_id = ? AND lower(trim(name)) = lower(trim(?)) AND trim(contact_email) = '' LIMIT 1`,
      ).bind(eventId, input.name).first<SpeakerRow>();
    if (existingSpeaker) {
      const existingParticipant = await context.env.DB.prepare(
        `SELECT id FROM proposal_presenters
        WHERE event_id = ? AND proposal_id = ? AND speaker_id = ? AND role = 'co_presenter' LIMIT 1`,
      ).bind(eventId, proposal.id, existingSpeaker.id).first<{ id: string }>();
      if (existingParticipant) {
        return context.json({
          data: await proposalParticipants(context, eventId, proposal.id),
          requestId: context.get("requestId"),
        });
      }
      // Submitter-supplied identity data must never silently link an existing
      // event speaker or account. Keep the response generic to limit what an
      // email probe can learn about private roster records.
      return errorResponse(
        context,
        409,
        "CO_PRESENTER_CONFLICT",
        "This co-presenter could not be added with the submitted details.",
      );
    }

    const presenterCount = await context.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM proposal_presenters WHERE event_id = ? AND proposal_id = ?",
    ).bind(eventId, proposal.id).first<{ count: number }>();
    if ((presenterCount?.count ?? 0) >= 20) {
      return errorResponse(context, 409, "CO_PRESENTER_LIMIT_REACHED", "This proposal has reached the participant limit.");
    }

    const speakerId = crypto.randomUUID();
    const presenterId = crypto.randomUUID();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const statements = [
      context.env.DB.prepare(
        `INSERT INTO speakers (
          id, event_id, user_id, slug, name, title, company, bio, contact_email,
          headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility,
          workflow_status, revision, updated_at
        ) SELECT ?, editable.event_id, NULL, ?, ?, '', '', '', ?, NULL, ?,
          'incomplete', 'missing', 'private', 'invited', 1, ?
        FROM proposals AS editable
        WHERE editable.id = ? AND editable.event_id = ? AND editable.owner_user_id = ?
          AND editable.status IN ('draft', 'submitted')
          AND (
            SELECT COUNT(*) FROM proposal_presenters
            WHERE event_id = editable.event_id AND proposal_id = editable.id
          ) < 20
          AND NOT EXISTS (
            SELECT 1 FROM acceptances
            WHERE event_id = editable.event_id AND proposal_id = editable.id
          )`,
      ).bind(
        speakerId,
        `${safeSlug(input.name)}-${speakerId.slice(0, 8)}`,
        input.name,
        normalizedEmail ?? "",
        initials(input.name),
        now,
        proposal.id,
        eventId,
        context.get("authUserId"),
      ),
      context.env.DB.prepare(
        `INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
        SELECT ?, ?, editable.id, ?, 'co_presenter'
        FROM proposals AS editable
        WHERE editable.id = ? AND editable.event_id = ? AND editable.owner_user_id = ?
          AND editable.status IN ('draft', 'submitted')
          AND (
            SELECT COUNT(*) FROM proposal_presenters
            WHERE event_id = editable.event_id AND proposal_id = editable.id
          ) < 20
          AND NOT EXISTS (
            SELECT 1 FROM acceptances
            WHERE event_id = editable.event_id AND proposal_id = editable.id
          )`,
      ).bind(
        presenterId,
        eventId,
        speakerId,
        proposal.id,
        eventId,
        context.get("authUserId"),
      ),
    ];
    try {
      const [, presenterInsert] = await context.env.DB.batch(statements);
      if ((presenterInsert.meta.changes ?? 0) !== 1) {
        const currentCount = await context.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM proposal_presenters WHERE event_id = ? AND proposal_id = ?",
        ).bind(eventId, proposal.id).first<{ count: number }>();
        if ((currentCount?.count ?? 0) >= 20) {
          return errorResponse(context, 409, "CO_PRESENTER_LIMIT_REACHED", "This proposal has reached the participant limit.");
        }
        return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal's participants can no longer be edited.");
      }
    } catch (error) {
      const current = await context.env.DB.prepare(
        `SELECT proposal.status,
          EXISTS(SELECT 1 FROM acceptances WHERE event_id = proposal.event_id AND proposal_id = proposal.id) AS accepted
        FROM proposals AS proposal WHERE proposal.id = ? AND proposal.event_id = ? LIMIT 1`,
      ).bind(proposal.id, eventId).first<{ status: ProposalRow["status"]; accepted: number }>();
      if (!current || !["draft", "submitted"].includes(current.status) || current.accepted === 1) {
        return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal's participants can no longer be edited.");
      }
      const racedSpeaker = normalizedEmail
        ? await context.env.DB.prepare(
          "SELECT id FROM speakers WHERE event_id = ? AND lower(trim(contact_email)) = ? LIMIT 1",
        ).bind(eventId, normalizedEmail).first<SpeakerRow>()
        : await context.env.DB.prepare(
          "SELECT id FROM speakers WHERE event_id = ? AND lower(trim(name)) = lower(trim(?)) AND trim(contact_email) = '' LIMIT 1",
        ).bind(eventId, input.name).first<SpeakerRow>();
      if (racedSpeaker) {
        return errorResponse(
          context,
          409,
          "CO_PRESENTER_CONFLICT",
          "This co-presenter could not be added with the submitted details.",
        );
      }
      throw error;
    }
    return context.json({
      data: await proposalParticipants(context, eventId, proposal.id),
      requestId: context.get("requestId"),
    }, 201);
  });

  routes.delete("/events/:eventSlug/proposals/:proposalId/co-presenters/:presenterId", async (context) => {
    const proposal = await ownedProposal(context);
    if (!proposal) return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    if (!["draft", "submitted"].includes(proposal.status)) {
      return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal's participants can no longer be edited.");
    }
    const config = await configByEventId(context);
    const closed = ensureOpen(context, config);
    if (closed) return closed;
    const eventId = context.get("authEventId");
    const participant = await context.env.DB.prepare(
      `SELECT id, speaker_id AS speakerId FROM proposal_presenters
      WHERE id = ? AND event_id = ? AND proposal_id = ? AND role = 'co_presenter' LIMIT 1`,
    ).bind(
      context.req.param("presenterId"),
      eventId,
      proposal.id,
    ).first<{ id: string; speakerId: string }>();
    if (!participant) {
      return errorResponse(context, 404, "CO_PRESENTER_NOT_FOUND", "The requested co-presenter does not exist.");
    }
    try {
      const [deleted] = await context.env.DB.batch([
        context.env.DB.prepare(
          `DELETE FROM proposal_presenters
          WHERE id = ? AND event_id = ? AND proposal_id = ? AND role = 'co_presenter'
            AND EXISTS (
              SELECT 1 FROM proposals AS editable
              WHERE editable.id = proposal_presenters.proposal_id
                AND editable.event_id = proposal_presenters.event_id
                AND editable.owner_user_id = ?
                AND editable.status IN ('draft', 'submitted')
            )
            AND NOT EXISTS (
              SELECT 1 FROM acceptances
              WHERE event_id = proposal_presenters.event_id
                AND proposal_id = proposal_presenters.proposal_id
            )`,
        ).bind(
          participant.id,
          eventId,
          proposal.id,
          context.get("authUserId"),
        ),
        context.env.DB.prepare(
          `DELETE FROM speakers WHERE id = ? AND event_id = ? AND user_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM proposal_presenters WHERE speaker_id = speakers.id)
            AND NOT EXISTS (SELECT 1 FROM session_presenters WHERE speaker_id = speakers.id)
            AND NOT EXISTS (SELECT 1 FROM speaker_claim_invitations WHERE speaker_id = speakers.id)`,
        ).bind(participant.speakerId, eventId),
      ]);
      if ((deleted.meta.changes ?? 0) !== 1) {
        const currentParticipant = await context.env.DB.prepare(
          `SELECT id FROM proposal_presenters
          WHERE id = ? AND event_id = ? AND proposal_id = ? AND role = 'co_presenter' LIMIT 1`,
        ).bind(context.req.param("presenterId"), eventId, proposal.id).first<{ id: string }>();
        if (currentParticipant) {
          return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal's participants can no longer be edited.");
        }
        return errorResponse(context, 404, "CO_PRESENTER_NOT_FOUND", "The requested co-presenter does not exist.");
      }
    } catch (error) {
      const current = await context.env.DB.prepare(
        `SELECT proposal.status,
          EXISTS(SELECT 1 FROM acceptances WHERE event_id = proposal.event_id AND proposal_id = proposal.id) AS accepted
        FROM proposals AS proposal WHERE proposal.id = ? AND proposal.event_id = ? LIMIT 1`,
      ).bind(proposal.id, eventId).first<{ status: ProposalRow["status"]; accepted: number }>();
      if (!current || !["draft", "submitted"].includes(current.status) || current.accepted === 1) {
        return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal's participants can no longer be edited.");
      }
      throw error;
    }
    return context.json({
      data: await proposalParticipants(context, eventId, proposal.id),
      requestId: context.get("requestId"),
    });
  });

  routes.put("/events/:eventSlug/proposals/:proposalId", async (context) => {
    const input = await parseJson(context, proposalDraftUpdateSchema);
    if (input instanceof Response) return input;
    const proposal = await ownedProposal(context);
    if (!proposal) return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    if (!['draft', 'submitted'].includes(proposal.status)) return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal can no longer be edited.");
    const config = await configByEventId(context);
    const closed = ensureOpen(context, config);
    if (closed) return closed;
    const eventId = context.get("authEventId");
    const fields = await fieldsForEvent(context, eventId);
    const issues = validateValues(fields, input.values, proposal.status === "submitted");
    if (issues.length) return errorResponse(context, 400, "PROPOSAL_INVALID", "Check the proposal fields and try again.", issues);
    const details = formatDetails(fields, input.values);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const statements = [
      context.env.DB.prepare(
        `UPDATE proposals SET title = ?, abstract = ?, track = ?, format = ?, duration_minutes = ?,
          updated_at = CASE
            WHEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) >= ?
              THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
            ELSE ?
          END
        WHERE id = ? AND event_id = ? AND owner_user_id = ? AND status IN ('draft', 'submitted')`,
      ).bind(valueFor(input.values, "title").trim() || "Untitled draft", valueFor(input.values, "abstract"), valueFor(input.values, "track"), details.format, details.durationMinutes, now, now, proposal.id, eventId, context.get("authUserId")),
      context.env.DB.prepare(
        `DELETE FROM proposal_answers
        WHERE event_id = ? AND proposal_id = ? AND field_key IN (
          SELECT field_key FROM cfp_fields WHERE event_id = ? AND active = 1
        ) AND EXISTS (
          SELECT 1 FROM proposals AS editable
          WHERE editable.id = ? AND editable.event_id = ? AND editable.owner_user_id = ?
            AND editable.status IN ('draft', 'submitted')
        )`,
      ).bind(eventId, proposal.id, eventId, proposal.id, eventId, context.get("authUserId")),
      ...Object.entries(input.values).map(([key, value]) => context.env.DB.prepare(
        `INSERT INTO proposal_answers (id, event_id, proposal_id, field_key, value, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM proposals AS editable
          WHERE editable.id = ? AND editable.event_id = ? AND editable.owner_user_id = ?
            AND editable.status IN ('draft', 'submitted')
        )`,
      ).bind(
        crypto.randomUUID(), eventId, proposal.id, key, value, now, now,
        proposal.id, eventId, context.get("authUserId"),
      )),
    ];
    if (Object.hasOwn(input.values, "speaker_bio")) {
      const speakerBio = valueFor(input.values, "speaker_bio");
      statements.push(
        context.env.DB.prepare(
          `UPDATE speakers
          SET bio = ?, revision = revision + 1,
            updated_at = CASE
              WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
              ELSE ?
            END
          WHERE event_id = ? AND user_id = ? AND bio != ?
            AND EXISTS (
              SELECT 1 FROM proposals AS editable
              WHERE editable.id = ? AND editable.event_id = ? AND editable.owner_user_id = ?
                AND editable.status IN ('draft', 'submitted')
            )`,
        ).bind(
          speakerBio, now, now, eventId, context.get("authUserId"), speakerBio,
          proposal.id, eventId, context.get("authUserId"),
        ),
      );
    }
    const [proposalUpdate] = await context.env.DB.batch(statements);
    if ((proposalUpdate.meta.changes ?? 0) !== 1) {
      return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal can no longer be edited.");
    }
    return context.json({ data: await proposalProjection(context, eventId, (await ownedProposal(context))!), requestId: context.get("requestId") });
  });

  routes.post("/events/:eventSlug/proposals/:proposalId/submit", async (context) => {
    const proposal = await ownedProposal(context);
    if (!proposal) return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    if (!['draft', 'submitted'].includes(proposal.status)) return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal can no longer be submitted.");
    const config = await configByEventId(context);
    const closed = ensureOpen(context, config);
    if (closed) return closed;
    const eventId = context.get("authEventId");
    const fields = await fieldsForEvent(context, eventId);
    const values = await proposalAnswers(context, eventId, proposal.id);
    const issues = validateValues(fields, values, true);
    if (issues.length) return errorResponse(context, 400, "PROPOSAL_INCOMPLETE", "Complete the required proposal fields before submitting.", issues);
    const details = formatDetails(fields, values);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const submitted = await context.env.DB.prepare(
      `UPDATE proposals SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?),
        title = ?, abstract = ?, track = ?, format = ?, duration_minutes = ?,
        updated_at = CASE
          WHEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) >= ?
            THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
          ELSE ?
        END
      WHERE id = ? AND event_id = ? AND owner_user_id = ? AND status IN ('draft', 'submitted')`,
    ).bind(
      now,
      valueFor(values, "title").trim() || "Untitled proposal",
      valueFor(values, "abstract"),
      valueFor(values, "track"),
      details.format,
      details.durationMinutes,
      now,
      now,
      proposal.id,
      eventId,
      context.get("authUserId"),
    ).run();
    if ((submitted.meta.changes ?? 0) !== 1) {
      return errorResponse(context, 409, "PROPOSAL_LOCKED", "This proposal can no longer be submitted.");
    }
    return context.json({ data: await proposalProjection(context, eventId, (await ownedProposal(context))!), requestId: context.get("requestId") });
  });

  return routes;
}
