import {
  authSessionSchema,
  normalizedEmailSchema,
  speakerClaimCreateResponseSchema,
  speakerClaimCreateSchema,
  speakerClaimListResponseSchema,
  speakerClaimRegisterSchema,
  speakerClaimResolveResponseSchema,
  speakerClaimResponseSchema,
  speakerClaimTokenRequestSchema,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { getAuthenticatedSession, hashToken, requireEventRole } from "./auth";
import { issueSession, sessionProjection } from "./auth-routes";
import { prepareMessageInsert, publicOutboxState } from "./features/messaging/message-outbox";
import { errorResponse } from "./http";
import { PASSWORD_ALGORITHM, PASSWORD_ITERATIONS, derivePasswordHash, randomPasswordSalt } from "./password";
import type { AppBindings } from "./types";
import { requestSource } from "./runtime/client-ip";

interface ClaimRow {
  id: string; eventId: string; eventSlug: string; eventName: string; speakerId: string; speakerName: string;
  email: string; state: "pending" | "accepted" | "revoked" | "expired"; expiresAt: string;
  createdAt: string; updatedAt: string; acceptedAt: string | null; revokedAt: string | null;
  outboxState: "queued" | "leased" | "delivered" | "failed" | null; outboxMessageId: string;
  cancellationCode: string | null; outboxUpdatedAt: string;
}

const CLAIM_SELECT = `SELECT claim.id, claim.event_id AS eventId, event.slug AS eventSlug,
  event.name AS eventName, claim.speaker_id AS speakerId, speaker.name AS speakerName,
  claim.email, claim.state, claim.expires_at AS expiresAt, claim.created_at AS createdAt,
  claim.updated_at AS updatedAt, claim.accepted_at AS acceptedAt, claim.revoked_at AS revokedAt,
  claim.outbox_message_id AS outboxMessageId, message.state AS outboxState,
  message.cancellation_code AS cancellationCode, message.updated_at AS outboxUpdatedAt
FROM speaker_claim_invitations AS claim
INNER JOIN events AS event ON event.id = claim.event_id
INNER JOIN speakers AS speaker ON speaker.id = claim.speaker_id AND speaker.event_id = claim.event_id
LEFT JOIN message_outbox AS message ON message.id = claim.outbox_message_id`;

function utcSeconds(date = new Date()) { return date.toISOString().replace(/\.\d{3}Z$/, "Z"); }
function addDays(now: string, days: number) { return utcSeconds(new Date(Date.parse(now) + days * 86_400_000)); }
function laterTimestamp(first: string, second: string) { return first > second ? first : second; }
function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function projection(row: ClaimRow) {
  const state = row.state === "pending" && Date.parse(row.expiresAt) <= Date.now() ? "expired" as const : row.state;
  const outboxState = row.outboxState === "delivered" ? "provider_accepted" as const
    : row.outboxState === "leased" ? "leased" as const
      : row.outboxState === "failed" ? "failed" as const
        : row.outboxState === "queued" && (row.cancellationCode !== null || state !== "pending") ? "suppressed" as const
          : row.outboxState ? publicOutboxState(row.outboxState) : null;
  return {
    id: row.id, speaker: { id: row.speakerId, name: row.speakerName }, email: row.email, state,
    expiresAt: row.expiresAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
    acceptedAt: row.acceptedAt, revokedAt: row.revokedAt, outboxState,
  };
}

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({ field: issue.path.map(String).join(".") || "form", message: issue.message }));
}
async function parseJson<T>(context: Context<AppBindings>, schema: { safeParse: (input: unknown) =>
  { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }) {
  let input: unknown;
  try { input = await context.req.json(); } catch { return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON."); }
  const result = schema.safeParse(input);
  return result.success ? result.data : errorResponse(context, 400, "VALIDATION_FAILED", "Check the submitted fields and try again.", zodIssues(result.error));
}
function contractData<T>(context: Context<AppBindings>, schema: { safeParse: (input: unknown) =>
  { success: true; data: T } | { success: false; error: unknown } }, data: NoInfer<T>, status: 200 | 201 = 200) {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error("Speaker claim response contract violation", { requestId: context.get("requestId") });
    return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION", "The speaker claim response could not be produced safely.");
  }
  return context.json({ data: result.data, requestId: context.get("requestId") }, status);
}
function unavailable(context: Context<AppBindings>) {
  return errorResponse(context, 410, "SPEAKER_CLAIM_UNAVAILABLE", "This speaker account invitation is invalid, expired, revoked, or already used.");
}
async function byToken(context: Context<AppBindings>, token: string) {
  return context.env.DB.prepare(`${CLAIM_SELECT} WHERE claim.token_hash = ? AND claim.state = 'pending'
    AND unixepoch(claim.expires_at) > unixepoch(?)
    AND speaker.user_id IS NULL AND lower(trim(speaker.contact_email)) = claim.email LIMIT 1`)
    .bind(await hashToken(token), utcSeconds()).first<ClaimRow>();
}
async function sourceRateLimit(context: Context<AppBindings>, scope: "resolve" | "register" | "accept") {
  const source = requestSource(context);
  const sourceResult = await context.env.LOGIN_SOURCE_RATE_LIMITER.limit({ key: await hashToken(`speaker-claim:${scope}:source:${source}`) });
  if (sourceResult.success) return null;
  context.header("retry-after", "60");
  return errorResponse(context, 429, "SPEAKER_CLAIM_RATE_LIMITED", "Too many speaker account attempts. Wait a minute and try again.");
}
async function accountRateLimit(context: Context<AppBindings>, scope: "register" | "accept", email: string) {
  if ((await context.env.LOGIN_ACCOUNT_RATE_LIMITER.limit({
    key: await hashToken(`speaker-claim:${scope}:account:${email}`),
  })).success) return null;
  context.header("retry-after", "60");
  return errorResponse(context, 429, "SPEAKER_CLAIM_RATE_LIMITED", "Too many speaker account attempts. Wait a minute and try again.");
}

export function createSpeakerClaimRoutes() {
  const routes = new Hono<AppBindings>();
  routes.use("/events/:eventSlug/speaker-claims", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/speaker-claims/*", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/speaker-claims", async (context) => {
    const speakerId = context.req.query("speakerId")?.trim() || null;
    if (speakerId !== null && speakerId.length > 200) {
      return errorResponse(context, 400, "VALIDATION_FAILED", "The speaker filter is invalid.");
    }
    const { results } = await context.env.DB.prepare(`${CLAIM_SELECT}
      WHERE claim.event_id = ? AND (? IS NULL OR claim.speaker_id = ?)
      ORDER BY claim.created_at DESC, claim.id DESC`)
      .bind(context.get("authEventId"), speakerId, speakerId).all<ClaimRow>();
    return contractData(context, speakerClaimListResponseSchema, { claims: results.map(projection) });
  });

  routes.post("/events/:eventSlug/speaker-claims", async (context) => {
    const input = await parseJson(context, speakerClaimCreateSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const existing = await context.env.DB.prepare(`${CLAIM_SELECT} WHERE claim.event_id = ? AND claim.idempotency_key = ? LIMIT 1`)
      .bind(eventId, input.idempotencyKey).first<ClaimRow>();
    if (existing) {
      if (existing.speakerId !== input.speakerId) return errorResponse(context, 409, "SPEAKER_CLAIM_IDEMPOTENCY_CONFLICT", "This idempotency key already identifies another speaker claim.");
      return contractData(context, speakerClaimCreateResponseSchema, { claim: projection(existing), acceptPath: null, replayed: true });
    }
    const now = utcSeconds();
    await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE message_outbox SET canceled_at = max(updated_at, ?), cancellation_code = 'MESSAGE_EXPIRED', updated_at = max(updated_at, ?)
        WHERE state IN ('queued', 'leased') AND canceled_at IS NULL AND id IN (
          SELECT outbox_message_id FROM speaker_claim_invitations WHERE event_id = ? AND speaker_id = ?
            AND state = 'pending' AND unixepoch(expires_at) <= unixepoch(?)
        )`).bind(now, now, eventId, input.speakerId, now),
      context.env.DB.prepare(`UPDATE speaker_claim_invitations SET state = 'expired', expired_at = expires_at, updated_at = max(updated_at, ?)
        WHERE event_id = ? AND speaker_id = ? AND state = 'pending' AND unixepoch(expires_at) <= unixepoch(?)`)
        .bind(now, eventId, input.speakerId, now),
    ]);
    const speaker = await context.env.DB.prepare(`SELECT speaker.id, speaker.name, lower(trim(speaker.contact_email)) AS email,
        event.name AS eventName FROM speakers AS speaker INNER JOIN events AS event ON event.id = speaker.event_id
      WHERE speaker.id = ? AND speaker.event_id = ? AND speaker.user_id IS NULL LIMIT 1`)
      .bind(input.speakerId, eventId).first<{ id: string; name: string; email: string; eventName: string }>();
    const parsedEmail = normalizedEmailSchema.safeParse(speaker?.email);
    if (!speaker || !parsedEmail.success || speaker.name !== speaker.name.trim() || speaker.name.length < 1 || speaker.name.length > 120) return errorResponse(context, 409, "SPEAKER_CLAIM_INELIGIBLE", "Choose an unclaimed speaker profile with a valid private contact email.");
    const email = parsedEmail.data;
    const conflict = await context.env.DB.prepare(`SELECT 1 AS found FROM speaker_claim_invitations
        WHERE event_id = ? AND speaker_id = ? AND state = 'pending'
      UNION ALL SELECT 1 FROM users AS user INNER JOIN event_memberships AS membership
        ON membership.user_id = user.id AND membership.event_id = ? AND membership.role = 'speaker'
        WHERE lower(trim(user.email)) = ? LIMIT 1`)
      .bind(eventId, speaker.id, eventId, email).first();
    if (conflict) return errorResponse(context, 409, "SPEAKER_CLAIM_CONFLICT", "This speaker already has speaker access or a pending account invitation.");
    const claimId = crypto.randomUUID(); const messageId = crypto.randomUUID(); const token = randomToken();
    const expiresAt = addDays(now, input.expiresInDays); const acceptPath = `/speaker-claim#${token}`;
    const absoluteLink = `${new URL("/speaker-claim", context.req.url).toString()}#${token}`;
    const message = await prepareMessageInsert(context.env.DB, {
      id: messageId, eventId, actorUserId: context.get("authUserId"), dedupeKey: `speaker-claim:${claimId}`,
      intent: "speaker_claim_invitation", recipientEmail: email, recipientName: speaker.name,
      templateKey: "speaker.account-claim", templateRevision: 1,
      subject: `Claim your speaker profile for ${speaker.eventName}`,
      text: `Hello ${speaker.name},\n\nAn organizer invited you to claim your speaker profile for ${speaker.eventName} in ConfPilot. Use this single-use link before ${expiresAt}:\n${absoluteLink}\n\nIf you were not expecting this invitation, you can ignore it.`,
      now, expiresAt,
    });
    try {
      await context.env.DB.batch([
        message.statement,
        context.env.DB.prepare(`INSERT INTO speaker_claim_invitations (
          id,event_id,speaker_id,email,token_hash,idempotency_key,state,expires_at,invited_by_user_id,
          accepted_by_user_id,revoked_by_user_id,outbox_message_id,created_at,updated_at,accepted_at,revoked_at,expired_at
        ) VALUES (?,?,?,?,?,?,'pending',?,?,NULL,NULL,?,?,?,NULL,NULL,NULL)`)
          .bind(claimId,eventId,speaker.id,email,await hashToken(token),input.idempotencyKey,expiresAt,
            context.get("authUserId"),messageId,now,now),
      ]);
    } catch (error) {
      const replay = await context.env.DB.prepare(`${CLAIM_SELECT} WHERE claim.event_id = ? AND claim.idempotency_key = ? LIMIT 1`)
        .bind(eventId, input.idempotencyKey).first<ClaimRow>();
      if (replay) return contractData(context, speakerClaimCreateResponseSchema, { claim: projection(replay), acceptPath: null, replayed: true });
      const pending = await context.env.DB.prepare(`${CLAIM_SELECT} WHERE claim.event_id = ? AND claim.speaker_id = ?
        AND claim.state = 'pending' AND unixepoch(claim.expires_at) > unixepoch(?) LIMIT 1`)
        .bind(eventId, speaker.id, now).first<ClaimRow>();
      if (pending) return errorResponse(context, 409, "SPEAKER_CLAIM_CONFLICT", "This speaker already has speaker access or a pending account invitation.");
      throw error;
    }
    const row = await context.env.DB.prepare(`${CLAIM_SELECT} WHERE claim.id = ? LIMIT 1`).bind(claimId).first<ClaimRow>();
    return contractData(context, speakerClaimCreateResponseSchema, { claim: projection(row!), acceptPath, replayed: false }, 201);
  });

  routes.post("/events/:eventSlug/speaker-claims/:claimId/revoke", async (context) => {
    const now = utcSeconds(); const claimId = context.req.param("claimId");
    const claim = await context.env.DB.prepare(`${CLAIM_SELECT} WHERE claim.id = ? AND claim.event_id = ?
      AND claim.state = 'pending' AND unixepoch(claim.expires_at) > unixepoch(?) LIMIT 1`)
      .bind(claimId, context.get("authEventId"), now).first<ClaimRow>();
    if (!claim) return errorResponse(context, 409, "SPEAKER_CLAIM_NOT_PENDING", "Only a pending speaker claim can be revoked.");
    const outboxNow = laterTimestamp(now, claim.outboxUpdatedAt);
    const claimNow = laterTimestamp(now, claim.updatedAt);
    await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE message_outbox SET canceled_at=?, cancellation_code='INVITATION_REVOKED', updated_at=?
        WHERE id=? AND state IN ('queued','leased') AND canceled_at IS NULL`).bind(outboxNow,outboxNow,claim.outboxMessageId),
      context.env.DB.prepare(`UPDATE speaker_claim_invitations SET state='revoked', revoked_by_user_id=?, revoked_at=?, updated_at=?
        WHERE id=? AND event_id=? AND state='pending'`).bind(context.get("authUserId"),claimNow,claimNow,claimId,context.get("authEventId")),
    ]);
    const row = await context.env.DB.prepare(`${CLAIM_SELECT} WHERE claim.id=? LIMIT 1`).bind(claimId).first<ClaimRow>();
    return contractData(context, speakerClaimResponseSchema, projection(row!));
  });

  routes.post("/speaker-claims/resolve", async (context) => {
    const input = await parseJson(context, speakerClaimTokenRequestSchema); if (input instanceof Response) return input;
    const limited = await sourceRateLimit(context, "resolve"); if (limited) return limited;
    const claim = await byToken(context, input.token); if (!claim) return unavailable(context);
    return contractData(context, speakerClaimResolveResponseSchema, {
      event: { slug: claim.eventSlug, name: claim.eventName }, speaker: { id: claim.speakerId, name: claim.speakerName },
      email: claim.email, expiresAt: claim.expiresAt,
    });
  });

  routes.post("/speaker-claims/accept", async (context) => {
    const session = await getAuthenticatedSession(context);
    if (!session) return errorResponse(context, 401, "UNAUTHENTICATED", "Sign in with the invited email to claim this speaker profile.");
    const input = await parseJson(context, speakerClaimTokenRequestSchema); if (input instanceof Response) return input;
    const sourceLimited = await sourceRateLimit(context,"accept"); if (sourceLimited) return sourceLimited;
    const claim = await byToken(context, input.token); if (!claim) return unavailable(context);
    if (session.email !== claim.email) return errorResponse(context, 403, "SPEAKER_CLAIM_EMAIL_MISMATCH", "Sign in with the exact email on the speaker profile.");
    const accountLimited = await accountRateLimit(context,"accept",claim.email); if (accountLimited) return accountLimited;
    const now = utcSeconds();
    const outboxNow = laterTimestamp(now, claim.outboxUpdatedAt);
    const claimNow = laterTimestamp(now, claim.updatedAt);
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(`UPDATE message_outbox SET canceled_at=?,cancellation_code='INVITATION_ACCEPTED',updated_at=?
          WHERE id=? AND state IN ('queued','leased') AND canceled_at IS NULL`).bind(outboxNow,outboxNow,claim.outboxMessageId),
        context.env.DB.prepare(`UPDATE speaker_claim_invitations SET state='accepted',accepted_by_user_id=?,accepted_at=?,updated_at=?
          WHERE id=? AND state='pending' AND token_hash=? AND unixepoch(expires_at)>unixepoch(?)`)
          .bind(session.userId,claimNow,claimNow,claim.id,await hashToken(input.token),now),
        context.env.DB.prepare(`INSERT INTO speaker_claim_acceptances (invitation_id,event_id,speaker_id,user_id,accepted_at)
          VALUES (?,?,?,?,?)`).bind(claim.id,claim.eventId,claim.speakerId,session.userId,claimNow),
        context.env.DB.prepare(`INSERT INTO event_memberships (id,event_id,user_id,role,created_at)
          VALUES (?,?,?,'speaker',?)`).bind(crypto.randomUUID(),claim.eventId,session.userId,now),
        context.env.DB.prepare(`UPDATE speakers SET user_id=? WHERE id=? AND event_id=? AND user_id IS NULL
          AND lower(trim(contact_email))=?`).bind(session.userId,claim.speakerId,claim.eventId,claim.email),
      ]);
    } catch (error) {
      if (!(await byToken(context,input.token))) return unavailable(context);
      const membership = await context.env.DB.prepare("SELECT 1 AS found FROM event_memberships WHERE event_id=? AND user_id=? AND role='speaker' LIMIT 1")
        .bind(claim.eventId, session.userId).first();
      if (membership) return errorResponse(context, 409, "SPEAKER_CLAIM_ROLE_CONFLICT", "This account already has speaker access for the event and cannot claim another speaker profile.");
      throw error;
    }
    return contractData(context, authSessionSchema, await sessionProjection(context, session));
  });

  routes.post("/speaker-claims/register", async (context) => {
    const input = await parseJson(context, speakerClaimRegisterSchema); if (input instanceof Response) return input;
    const sourceLimited = await sourceRateLimit(context,"register"); if (sourceLimited) return sourceLimited;
    const claim = await byToken(context,input.token); if (!claim) return unavailable(context);
    const accountLimited = await accountRateLimit(context,"register",claim.email); if (accountLimited) return accountLimited;
    if (await context.env.DB.prepare("SELECT 1 AS found FROM users WHERE lower(trim(email))=? LIMIT 1").bind(claim.email).first())
      return errorResponse(context,409,"SPEAKER_CLAIM_SIGN_IN_REQUIRED","An account already uses this email. Sign in to claim the profile.");
    const userId=crypto.randomUUID(); const salt=randomPasswordSalt(); let passwordHash:string;
    try { passwordHash=await derivePasswordHash(input.password,salt,PASSWORD_ITERATIONS); }
    catch { return errorResponse(context,503,"REGISTRATION_UNAVAILABLE","Account creation is temporarily unavailable."); }
    const now=utcSeconds(); const outboxNow=laterTimestamp(now,claim.outboxUpdatedAt); const claimNow=laterTimestamp(now,claim.updatedAt);
    try {
      await context.env.DB.batch([
        context.env.DB.prepare("INSERT INTO users (id,email,display_name,created_at) VALUES (?,?,?,?)").bind(userId,claim.email,input.displayName,now),
        context.env.DB.prepare(`INSERT INTO user_credentials (user_id,password_salt,password_hash,algorithm,iterations,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?)`).bind(userId,salt,passwordHash,PASSWORD_ALGORITHM,PASSWORD_ITERATIONS,now,now),
        context.env.DB.prepare(`UPDATE message_outbox SET canceled_at=?,cancellation_code='INVITATION_ACCEPTED',updated_at=?
          WHERE id=? AND state IN ('queued','leased') AND canceled_at IS NULL`).bind(outboxNow,outboxNow,claim.outboxMessageId),
        context.env.DB.prepare(`UPDATE speaker_claim_invitations SET state='accepted',accepted_by_user_id=?,accepted_at=?,updated_at=?
          WHERE id=? AND state='pending' AND token_hash=? AND unixepoch(expires_at)>unixepoch(?)`)
          .bind(userId,claimNow,claimNow,claim.id,await hashToken(input.token),now),
        context.env.DB.prepare(`INSERT INTO speaker_claim_acceptances (invitation_id,event_id,speaker_id,user_id,accepted_at)
          VALUES (?,?,?,?,?)`).bind(claim.id,claim.eventId,claim.speakerId,userId,claimNow),
        context.env.DB.prepare(`INSERT INTO event_memberships (id,event_id,user_id,role,created_at)
          VALUES (?,?,?,'speaker',?)`).bind(crypto.randomUUID(),claim.eventId,userId,now),
        context.env.DB.prepare(`UPDATE speakers SET user_id=? WHERE id=? AND event_id=? AND user_id IS NULL
          AND lower(trim(contact_email))=?`).bind(userId,claim.speakerId,claim.eventId,claim.email),
      ]);
    } catch (error) {
      if (await context.env.DB.prepare("SELECT 1 FROM users WHERE lower(trim(email))=? LIMIT 1").bind(claim.email).first())
        return errorResponse(context,409,"SPEAKER_CLAIM_SIGN_IN_REQUIRED","An account already uses this email. Sign in to claim the profile.");
      if (!(await byToken(context,input.token))) return unavailable(context); throw error;
    }
    await issueSession(context,userId);
    return contractData(context,authSessionSchema,await sessionProjection(context,{ userId,email:claim.email,displayName:input.displayName }),201);
  });

  return routes;
}
