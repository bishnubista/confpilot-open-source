import {
  authSessionSchema,
  reviewerInvitationCreateResponseSchema,
  reviewerInvitationCreateSchema,
  reviewerInvitationListResponseSchema,
  reviewerInvitationRegisterSchema,
  reviewerInvitationResolveResponseSchema,
  reviewerInvitationResponseSchema,
  reviewerInvitationTokenRequestSchema,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { getAuthenticatedSession, hashToken, requireEventRole } from "./auth";
import { issueSession, sessionProjection } from "./auth-routes";
import { prepareMessageInsert, publicOutboxState } from "./features/messaging/message-outbox";
import { errorResponse } from "./http";
import {
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  derivePasswordHash,
  randomPasswordSalt,
} from "./password";
import type { AppBindings } from "./types";
import { requestSource } from "./runtime/client-ip";

interface InvitationRow {
  id: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  email: string;
  displayName: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  expiredAt: string | null;
  outboxState: "queued" | "leased" | "delivered" | "failed" | null;
  outboxMessageId: string;
  cancellationCode: string | null;
}

const INVITATION_SELECT = `SELECT invitation.id, invitation.event_id AS eventId,
  event.slug AS eventSlug, event.name AS eventName,
  invitation.email, invitation.display_name AS displayName, invitation.state,
  invitation.expires_at AS expiresAt, invitation.created_at AS createdAt,
  invitation.updated_at AS updatedAt, invitation.accepted_at AS acceptedAt,
  invitation.revoked_at AS revokedAt, invitation.expired_at AS expiredAt,
  invitation.outbox_message_id AS outboxMessageId,
  message.state AS outboxState,
  message.cancellation_code AS cancellationCode
FROM reviewer_invitations AS invitation
INNER JOIN events AS event ON event.id = invitation.event_id
LEFT JOIN message_outbox AS message ON message.id = invitation.outbox_message_id`;

function utcSeconds(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addDays(now: string, days: number) {
  return utcSeconds(new Date(Date.parse(now) + days * 86_400_000));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function projection(row: InvitationRow) {
  const state = row.state === "pending" && Date.parse(row.expiresAt) <= Date.now() ? "expired" as const : row.state;
  const outboxState = row.outboxState === "delivered"
    ? "provider_accepted" as const
    : row.outboxState === "leased"
      ? "leased" as const
      : row.outboxState === "failed"
        ? "failed" as const
        : row.outboxState === "queued" && (row.cancellationCode !== null || state !== "pending")
          ? "suppressed" as const
          : row.outboxState ? publicOutboxState(row.outboxState) : null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    state,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    outboxState,
  };
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
}

async function parseJson<T>(context: Context<AppBindings>, schema: {
  safeParse: (input: unknown) =>
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}): Promise<T | Response> {
  let input: unknown;
  try {
    input = await context.req.json();
  } catch {
    return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    return errorResponse(context, 400, "VALIDATION_FAILED", "Check the submitted fields and try again.", zodIssues(result.error));
  }
  return result.data;
}

function contractData<T>(context: Context<AppBindings>, schema: {
  safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: unknown };
}, data: NoInfer<T>, status: 200 | 201 = 200) {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error("Reviewer invitation response contract violation", { requestId: context.get("requestId") });
    return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION", "The reviewer invitation response could not be produced safely.");
  }
  return context.json({ data: result.data, requestId: context.get("requestId") }, status);
}

function unavailable(context: Context<AppBindings>) {
  return errorResponse(context, 410, "REVIEWER_INVITATION_UNAVAILABLE", "This reviewer invitation is invalid, expired, revoked, or already used.");
}

async function invitationByToken(context: Context<AppBindings>, token: string) {
  return context.env.DB.prepare(`${INVITATION_SELECT}
    WHERE invitation.token_hash = ? AND invitation.state = 'pending'
      AND unixepoch(invitation.expires_at) > unixepoch(?)
    LIMIT 1`)
    .bind(await hashToken(token), utcSeconds()).first<InvitationRow>();
}

async function rateLimitRegistrationSource(context: Context<AppBindings>) {
  const source = requestSource(context);
  const sourceResult = await context.env.LOGIN_SOURCE_RATE_LIMITER.limit({
    key: await hashToken(`reviewer-invite:source:${source}`),
  });
  if (sourceResult.success) return null;
  context.header("retry-after", "60");
  return errorResponse(context, 429, "REGISTRATION_RATE_LIMITED", "Too many account attempts. Wait a minute and try again.");
}

async function rateLimitRegistrationAccount(context: Context<AppBindings>, email: string) {
  const accountResult = await context.env.LOGIN_ACCOUNT_RATE_LIMITER.limit({
    key: await hashToken(`reviewer-invite:account:${email}`),
  });
  if (accountResult.success) return null;
  context.header("retry-after", "60");
  return errorResponse(context, 429, "REGISTRATION_RATE_LIMITED", "Too many account attempts. Wait a minute and try again.");
}

async function rateLimitResolution(context: Context<AppBindings>) {
  const source = requestSource(context);
  const result = await context.env.LOGIN_SOURCE_RATE_LIMITER.limit({
    key: await hashToken(`reviewer-invite:resolve:${source}`),
  });
  if (result.success) return null;
  context.header("retry-after", "60");
  return errorResponse(context, 429, "INVITATION_RESOLUTION_RATE_LIMITED", "Too many invitation checks. Wait a minute and try again.");
}

export function createEventInvitationRoutes() {
  const routes = new Hono<AppBindings>();

  routes.use("/events/:eventSlug/reviewer-invitations/*", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/reviewer-invitations", async (context) => {
    const { results } = await context.env.DB.prepare(`${INVITATION_SELECT}
      WHERE invitation.event_id = ?
      ORDER BY invitation.created_at DESC, invitation.id DESC`)
      .bind(context.get("authEventId")).all<InvitationRow>();
    return contractData(context, reviewerInvitationListResponseSchema, {
      invitations: results.map(projection),
    });
  });

  routes.post("/events/:eventSlug/reviewer-invitations", async (context) => {
    const input = await parseJson(context, reviewerInvitationCreateSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const existing = await context.env.DB.prepare(`${INVITATION_SELECT}
      WHERE invitation.event_id = ? AND invitation.idempotency_key = ? LIMIT 1`)
      .bind(eventId, input.idempotencyKey).first<InvitationRow>();
    if (existing) {
      if (existing.email !== input.email || existing.displayName !== input.displayName) {
        return errorResponse(context, 409, "REVIEWER_INVITATION_IDEMPOTENCY_CONFLICT", "This idempotency key already identifies a different reviewer invitation.");
      }
      return contractData(context, reviewerInvitationCreateResponseSchema, {
        invitation: projection(existing), acceptPath: null, replayed: true,
      });
    }
    const requestNow = utcSeconds();
    await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE message_outbox
        SET canceled_at = max(updated_at, ?), cancellation_code = 'MESSAGE_EXPIRED', updated_at = max(updated_at, ?)
        WHERE state IN ('queued', 'leased') AND canceled_at IS NULL AND id IN (
          SELECT outbox_message_id FROM reviewer_invitations
          WHERE event_id = ? AND email = ? AND state = 'pending'
            AND unixepoch(expires_at) <= unixepoch(?)
        )`).bind(requestNow, requestNow, eventId, input.email, requestNow),
      context.env.DB.prepare(`UPDATE reviewer_invitations
        SET state = 'expired', expired_at = expires_at, updated_at = max(updated_at, ?)
        WHERE event_id = ? AND email = ? AND state = 'pending'
          AND unixepoch(expires_at) <= unixepoch(?)`)
        .bind(requestNow, eventId, input.email, requestNow),
    ]);
    const conflict = await context.env.DB.prepare(`SELECT 1 AS found
      FROM users AS user INNER JOIN event_memberships AS membership
        ON membership.user_id = user.id AND membership.event_id = ? AND membership.role = 'reviewer'
      WHERE lower(trim(user.email)) = ?
      UNION ALL
      SELECT 1 FROM reviewer_invitations
      WHERE event_id = ? AND email = ? AND state = 'pending'
      LIMIT 1`)
      .bind(eventId, input.email, eventId, input.email).first<{ found: number }>();
    if (conflict) {
      return errorResponse(context, 409, "REVIEWER_INVITATION_CONFLICT", "This email already has reviewer access or a pending invitation.");
    }

    const invitationId = crypto.randomUUID();
    const token = randomToken();
    const now = requestNow;
    const expiresAt = addDays(now, input.expiresInDays);
    const acceptPath = `/reviewer-invitation#${token}`;
    const absoluteLink = `${new URL("/reviewer-invitation", context.req.url).toString()}#${token}`;
    const messageId = crypto.randomUUID();
    const event = await context.env.DB.prepare("SELECT name FROM events WHERE id = ? LIMIT 1")
      .bind(eventId).first<{ name: string }>();
    const preparedMessage = await prepareMessageInsert(context.env.DB, {
      id: messageId,
      eventId,
      actorUserId: context.get("authUserId"),
      dedupeKey: `reviewer-invitation:${invitationId}`,
      intent: "reviewer_invitation",
      recipientEmail: input.email,
      recipientName: input.displayName,
      templateKey: "reviewer.account-invitation",
      templateRevision: 1,
      subject: `You are invited to review proposals for ${event!.name}`,
      text: `Hello ${input.displayName},\n\nAn organizer invited you to review proposals for ${event!.name} in ConfPilot. Accept this single-use invitation before ${expiresAt}:\n${absoluteLink}\n\nIf you were not expecting this invitation, you can ignore it.`,
      now,
      expiresAt,
    });
    try {
      await context.env.DB.batch([
        preparedMessage.statement,
        context.env.DB.prepare(`INSERT INTO reviewer_invitations (
          id, event_id, email, display_name, token_hash, idempotency_key, state,
          expires_at, invited_by_user_id, accepted_by_user_id, revoked_by_user_id,
          outbox_message_id, created_at, updated_at, accepted_at, revoked_at, expired_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)`)
          .bind(
            invitationId, eventId, input.email, input.displayName, await hashToken(token),
            input.idempotencyKey, expiresAt, context.get("authUserId"), messageId, now, now,
          ),
      ]);
    } catch (error) {
      const replay = await context.env.DB.prepare(`${INVITATION_SELECT}
        WHERE invitation.event_id = ? AND invitation.idempotency_key = ? LIMIT 1`)
        .bind(eventId, input.idempotencyKey).first<InvitationRow>();
      if (replay) {
        return contractData(context, reviewerInvitationCreateResponseSchema, {
          invitation: projection(replay), acceptPath: null, replayed: true,
        });
      }
      const pending = await context.env.DB.prepare("SELECT 1 AS found FROM reviewer_invitations WHERE event_id = ? AND email = ? AND state = 'pending' LIMIT 1")
        .bind(eventId, input.email).first<{ found: number }>();
      if (pending) return errorResponse(context, 409, "REVIEWER_INVITATION_CONFLICT", "This email already has reviewer access or a pending invitation.");
      const reviewer = await context.env.DB.prepare(`SELECT 1 AS found
        FROM users AS user INNER JOIN event_memberships AS membership
          ON membership.user_id = user.id AND membership.event_id = ? AND membership.role = 'reviewer'
        WHERE lower(trim(user.email)) = ? LIMIT 1`)
        .bind(eventId, input.email).first<{ found: number }>();
      if (reviewer) return errorResponse(context, 409, "REVIEWER_INVITATION_CONFLICT", "This email already has reviewer access or a pending invitation.");
      throw error;
    }
    const row = await context.env.DB.prepare(`${INVITATION_SELECT} WHERE invitation.id = ? LIMIT 1`)
      .bind(invitationId).first<InvitationRow>();
    return contractData(context, reviewerInvitationCreateResponseSchema, {
      invitation: projection(row!), acceptPath, replayed: false,
    }, 201);
  });

  routes.post("/events/:eventSlug/reviewer-invitations/:invitationId/revoke", async (context) => {
    const now = utcSeconds();
    const invitationId = context.req.param("invitationId");
    const invitation = await context.env.DB.prepare(`${INVITATION_SELECT}
      WHERE invitation.id = ? AND invitation.event_id = ? AND invitation.state = 'pending'
        AND unixepoch(invitation.expires_at) > unixepoch(?) LIMIT 1`)
      .bind(invitationId, context.get("authEventId"), now).first<InvitationRow>();
    if (!invitation) {
      return errorResponse(context, 409, "REVIEWER_INVITATION_NOT_PENDING", "Only a pending invitation can be revoked.");
    }
    const results = await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE message_outbox
        SET canceled_at = max(updated_at, ?), cancellation_code = 'INVITATION_REVOKED', updated_at = max(updated_at, ?)
        WHERE id = ? AND state IN ('queued', 'leased') AND canceled_at IS NULL`)
        .bind(now, now, invitation.outboxMessageId),
      context.env.DB.prepare(`UPDATE reviewer_invitations
        SET state = 'revoked', revoked_by_user_id = ?,
          revoked_at = max(updated_at, ?), updated_at = max(updated_at, ?)
        WHERE id = ? AND event_id = ? AND state = 'pending'`)
        .bind(context.get("authUserId"), now, now, invitationId, context.get("authEventId")),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      return errorResponse(context, 409, "REVIEWER_INVITATION_NOT_PENDING", "Only a pending invitation can be revoked.");
    }
    const row = await context.env.DB.prepare(`${INVITATION_SELECT} WHERE invitation.id = ? AND invitation.event_id = ? LIMIT 1`)
      .bind(invitationId, context.get("authEventId")).first<InvitationRow>();
    return contractData(context, reviewerInvitationResponseSchema, projection(row!));
  });

  routes.post("/reviewer-invitations/resolve", async (context) => {
    const input = await parseJson(context, reviewerInvitationTokenRequestSchema);
    if (input instanceof Response) return input;
    const limited = await rateLimitResolution(context);
    if (limited) return limited;
    const invitation = await invitationByToken(context, input.token);
    if (!invitation) return unavailable(context);
    return contractData(context, reviewerInvitationResolveResponseSchema, {
      event: { slug: invitation.eventSlug, name: invitation.eventName },
      email: invitation.email,
      displayName: invitation.displayName,
      expiresAt: invitation.expiresAt,
    });
  });

  routes.post("/reviewer-invitations/accept", async (context) => {
    const session = await getAuthenticatedSession(context);
    if (!session) return errorResponse(context, 401, "UNAUTHENTICATED", "Sign in with the invited email to accept this reviewer invitation.");
    const input = await parseJson(context, reviewerInvitationTokenRequestSchema);
    if (input instanceof Response) return input;
    const limited = await rateLimitResolution(context);
    if (limited) return limited;
    const invitation = await invitationByToken(context, input.token);
    if (!invitation) return unavailable(context);
    if (session.email !== invitation.email) {
      return errorResponse(context, 403, "REVIEWER_INVITATION_EMAIL_MISMATCH", "Sign in with the exact email address that received this invitation.");
    }
    const now = utcSeconds();
    try {
      const results = await context.env.DB.batch([
        context.env.DB.prepare(`UPDATE message_outbox
          SET canceled_at = ?, cancellation_code = 'INVITATION_ACCEPTED', updated_at = ?
          WHERE id = ? AND state IN ('queued', 'leased') AND canceled_at IS NULL`)
          .bind(now, now, invitation.outboxMessageId),
        context.env.DB.prepare(`UPDATE reviewer_invitations SET state = 'accepted',
          accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
          WHERE id = ? AND state = 'pending' AND token_hash = ? AND unixepoch(expires_at) > unixepoch(?)`)
          .bind(session.userId, now, now, invitation.id, await hashToken(input.token), now),
        context.env.DB.prepare(`INSERT INTO reviewer_invitation_acceptances
          (invitation_id, event_id, user_id, accepted_at) VALUES (?, ?, ?, ?)`)
          .bind(invitation.id, invitation.eventId, session.userId, now),
        context.env.DB.prepare(`INSERT INTO event_memberships
          (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'reviewer', ?)`)
          .bind(crypto.randomUUID(), invitation.eventId, session.userId, now),
      ]);
      if ((results[1]?.meta.changes ?? 0) !== 1) return unavailable(context);
    } catch (error) {
      if (!(await invitationByToken(context, input.token))) return unavailable(context);
      const membership = await context.env.DB.prepare("SELECT 1 AS found FROM event_memberships WHERE event_id = ? AND user_id = ? AND role = 'reviewer' LIMIT 1")
        .bind(invitation.eventId, session.userId).first<{ found: number }>();
      if (membership) {
        return errorResponse(context, 409, "REVIEWER_INVITATION_ROLE_CONFLICT", "This account already has reviewer access for the event.");
      }
      throw error;
    }
    return contractData(context, authSessionSchema, await sessionProjection(context, session));
  });

  routes.post("/reviewer-invitations/register", async (context) => {
    const input = await parseJson(context, reviewerInvitationRegisterSchema);
    if (input instanceof Response) return input;
    const sourceLimited = await rateLimitRegistrationSource(context);
    if (sourceLimited) return sourceLimited;
    const invitation = await invitationByToken(context, input.token);
    if (!invitation) return unavailable(context);
    const accountLimited = await rateLimitRegistrationAccount(context, invitation.email);
    if (accountLimited) return accountLimited;
    const duplicate = await context.env.DB.prepare("SELECT 1 AS found FROM users WHERE lower(trim(email)) = ? LIMIT 1")
      .bind(invitation.email).first<{ found: number }>();
    if (duplicate) {
      return errorResponse(context, 409, "REVIEWER_INVITATION_SIGN_IN_REQUIRED", "An account already uses this email. Sign in to accept the invitation.");
    }
    const userId = crypto.randomUUID();
    const salt = randomPasswordSalt();
    let passwordHash: string;
    try {
      passwordHash = await derivePasswordHash(input.password, salt, PASSWORD_ITERATIONS);
    } catch {
      return errorResponse(context, 503, "REGISTRATION_UNAVAILABLE", "Account creation is temporarily unavailable. Try again shortly.");
    }
    const now = utcSeconds();
    try {
      await context.env.DB.batch([
        context.env.DB.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
          .bind(userId, invitation.email, input.displayName, now),
        context.env.DB.prepare(`INSERT INTO user_credentials (
          user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(userId, salt, passwordHash, PASSWORD_ALGORITHM, PASSWORD_ITERATIONS, now, now),
        context.env.DB.prepare(`UPDATE message_outbox
          SET canceled_at = ?, cancellation_code = 'INVITATION_ACCEPTED', updated_at = ?
          WHERE id = ? AND state IN ('queued', 'leased') AND canceled_at IS NULL`)
          .bind(now, now, invitation.outboxMessageId),
        context.env.DB.prepare(`UPDATE reviewer_invitations SET state = 'accepted',
          accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
          WHERE id = ? AND state = 'pending' AND token_hash = ? AND unixepoch(expires_at) > unixepoch(?)`)
          .bind(userId, now, now, invitation.id, await hashToken(input.token), now),
        context.env.DB.prepare(`INSERT INTO reviewer_invitation_acceptances
          (invitation_id, event_id, user_id, accepted_at) VALUES (?, ?, ?, ?)`)
          .bind(invitation.id, invitation.eventId, userId, now),
        context.env.DB.prepare(`INSERT INTO event_memberships
          (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'reviewer', ?)`)
          .bind(crypto.randomUUID(), invitation.eventId, userId, now),
      ]);
    } catch (error) {
      const account = await context.env.DB.prepare("SELECT 1 AS found FROM users WHERE lower(trim(email)) = ? LIMIT 1")
        .bind(invitation.email).first<{ found: number }>();
      if (account) {
        return errorResponse(context, 409, "REVIEWER_INVITATION_SIGN_IN_REQUIRED", "An account already uses this email. Sign in to accept the invitation.");
      }
      if (!(await invitationByToken(context, input.token))) return unavailable(context);
      throw error;
    }
    await issueSession(context, userId);
    return contractData(context, authSessionSchema, await sessionProjection(context, {
      userId, email: invitation.email, displayName: input.displayName,
    }), 201);
  });

  return routes;
}
