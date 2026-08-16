import {
  evaluationPlanVersionSchema,
  evaluationPlanWriteSchema,
  organizerProposalReviewProgressResponseSchema,
  organizerProposalReviewDetailResponseSchema,
  organizerReviewAssignmentCreateSchema,
  reviewAssignmentLifecycleResponseSchema,
  reviewAutoAssignRequestSchema,
  reviewAutoAssignResultSchema,
  reviewInvitationResponseRequestSchema,
  reviewRecusalRequestSchema,
  reviewRoundListResponseSchema,
  reviewRoundPoolResponseSchema,
  reviewRoundPoolWriteSchema,
  reviewRoundResponseSchema,
  reviewRoundUpdateSchema,
  reviewRoundWriteSchema,
  reviewerConflictDeclareSchema,
  reviewerAssignmentDetailResponseSchema,
  reviewerAssignmentQueueResponseSchema,
  reviewerMembershipListResponseSchema,
  reviewerProgressResponseSchema,
  reviewerReminderEnqueueSchema,
  reviewerReminderResponseSchema,
  reviewAssignmentResponseSchema,
  reviewAssignmentRevokeResponseSchema,
  reviewScorecardSubmitSchema,
  submittedReviewSchema,
} from "@confpilot/contracts";
import { Hono, type Context } from "hono";

import { requireEventRole } from "../../auth";
import { errorResponse } from "../../http";
import {
  enqueueReviewerReminder,
  ReviewerReminderAuthorizationError,
  ReviewerReminderIdempotencyConflictError,
  ReviewerReminderIneligibleError,
  ReviewerReminderNotFoundError,
  ReviewerReminderTemplateNotFoundError,
} from "../../reviewer-reminders";
import type { AppBindings } from "../../types";
import { listProposalReviewResults, proposalReviewResultsCsv } from "./review-results";
import {
  activeEvaluationPlan,
  createEvaluationPlanVersion,
  EvaluationPlanConflictError,
  evaluationPlanByVersion,
  weightedScoreMilli,
} from "./review-plan";
import { constraintMessage } from "../../runtime/database";

interface ReviewerRow {
  userId: string;
  displayName: string;
  email: string;
}

interface ProposalForAssignmentRow {
  id: string;
  ownerUserId: string | null;
  status: "draft" | "submitted" | "in_review" | "decided";
}

interface AssignmentRow {
  id: string;
  eventId: string;
  proposalId: string;
  reviewerUserId: string;
  reviewerName: string;
  reviewerEmail: string;
  proposalPublicId: string;
  proposalTitle: string;
  round: number;
  reviewRoundId: string | null;
  blind: number;
  state: "assigned" | "revoked";
  dueAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  reviewId: string | null;
  reviewPlanVersionId: string | null;
  requiresResponse: number;
  invitationStatus: "pending" | "accepted" | "declined" | "recused";
  respondedAt: string | null;
  responseReason: string | null;
  conflictCategory: "author_relationship" | "institutional" | "financial" | "personal" | "other" | null;
  conflictNote: string | null;
  conflictDeclaredAt: string | null;
}

interface QueueRow {
  id: string;
  round: number;
  blind: number;
  dueAt: string | null;
  createdAt: string;
  proposalId: string;
  publicId: string;
  title: string;
  track: string;
  format: "keynote" | "talk" | "lightning" | "workshop" | "panel";
  durationMinutes: number;
  reviewId: string | null;
  invitationStatus: AssignmentRow["invitationStatus"];
  conflictCategory: AssignmentRow["conflictCategory"];
  conflictNote: string | null;
  conflictDeclaredAt: string | null;
}

interface DetailRow extends QueueRow {
  abstract: string;
  ownerName: string | null;
  originality: number | null;
  relevance: number | null;
  recommendation: "accept" | "discuss" | "reject" | null;
  comment: string | null;
  submittedAt: string | null;
  reviewPlanVersionId: string | null;
  weightedScoreMilli: number | null;
  reviewRoundId: string | null;
  proposalStatus: ProposalForAssignmentRow["status"];
  respondedAt: string | null;
  responseReason: string | null;
}

interface AnswerRow {
  fieldKey: string;
  value: string;
}

interface ReviewRow {
  id: string;
  baseReviewId: string;
  eventId: string;
  assignmentId: string;
  originality: number;
  relevance: number;
  recommendation: "accept" | "discuss" | "reject";
  comment: string;
  submittedAt: string;
  correctedAt: string | null;
  revisionNumber: number;
  reviewPlanVersionId: string | null;
  weightedScoreMilli: number | null;
}

interface CriterionScoreRow {
  criterionId: string;
  key: string;
  label: string;
  score: number;
}

interface ProgressRow {
  assignmentId: string;
  reviewerUserId: string;
  reviewerName: string;
  round: number;
  blind: number;
  state: "assigned" | "revoked";
  dueAt: string | null;
  createdAt: string;
  reviewId: string | null;
  originality: number | null;
  relevance: number | null;
  recommendation: "accept" | "discuss" | "reject" | null;
  comment: string | null;
  submittedAt: string | null;
  invitationStatus: AssignmentRow["invitationStatus"];
  conflictCategory: AssignmentRow["conflictCategory"];
  conflictNote: string | null;
  conflictDeclaredAt: string | null;
  respondedAt: string | null;
  responseReason: string | null;
}

const INVITATION_STATUS_SQL = `COALESCE((
  SELECT action.action FROM review_assignment_actions AS action
  WHERE action.assignment_id = assignment.id
  ORDER BY action.sequence DESC LIMIT 1
), CASE WHEN assignment.requires_response = 1 THEN 'pending' ELSE 'accepted' END)`;

function conflictProjection(row: Pick<AssignmentRow, "conflictCategory" | "conflictNote" | "conflictDeclaredAt">) {
  return row.conflictCategory && row.conflictNote && row.conflictDeclaredAt ? {
    category: row.conflictCategory,
    note: row.conflictNote,
    declaredAt: row.conflictDeclaredAt,
  } : null;
}

const ASSIGNMENT_SELECT = `SELECT
  assignment.id,
  assignment.event_id AS eventId,
  assignment.proposal_id AS proposalId,
  assignment.reviewer_user_id AS reviewerUserId,
  reviewer.display_name AS reviewerName,
  lower(trim(reviewer.email)) AS reviewerEmail,
  proposal.public_id AS proposalPublicId,
  proposal.title AS proposalTitle,
  assignment.round,
  assignment.blind,
  assignment.state,
  assignment.due_at AS dueAt,
  assignment.created_at AS createdAt,
  assignment.revoked_at AS revokedAt,
  assignment.review_plan_version_id AS reviewPlanVersionId,
  assignment.requires_response AS requiresResponse,
  assignment.review_round_id AS reviewRoundId,
  ${INVITATION_STATUS_SQL} AS invitationStatus,
  (SELECT action.created_at FROM review_assignment_actions AS action
    WHERE action.assignment_id = assignment.id ORDER BY action.sequence DESC LIMIT 1) AS respondedAt,
  (SELECT action.reason FROM review_assignment_actions AS action
    WHERE action.assignment_id = assignment.id ORDER BY action.sequence DESC LIMIT 1) AS responseReason,
  conflict.category AS conflictCategory,
  conflict.note AS conflictNote,
  conflict.created_at AS conflictDeclaredAt,
  review.id AS reviewId
FROM review_assignments AS assignment
INNER JOIN users AS reviewer ON reviewer.id = assignment.reviewer_user_id
INNER JOIN proposals AS proposal
  ON proposal.id = assignment.proposal_id AND proposal.event_id = assignment.event_id
LEFT JOIN current_reviews AS review ON review.assignment_id = assignment.id
  AND review.event_id = assignment.event_id
LEFT JOIN reviewer_conflicts AS conflict ON conflict.assignment_id = assignment.id`;

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "form",
    message: issue.message,
  }));
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
    console.error("Review response contract violation", {
      requestId: context.get("requestId"),
      issues: result.error.issues,
    });
    return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION", "The review response could not be produced safely.");
  }
  return context.json({ data: result.data, requestId: context.get("requestId") }, status);
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

function assignmentProjection(row: AssignmentRow) {
  return {
    id: row.id,
    round: row.round,
    reviewRoundId: row.reviewRoundId,
    blind: row.blind === 1,
    dueAt: row.dueAt,
    status: row.state === "revoked" ? "revoked" as const : row.reviewId ? "completed" as const : "pending" as const,
    invitationStatus: row.invitationStatus,
    assignedAt: row.createdAt,
    revokedAt: row.revokedAt,
    proposal: { id: row.proposalId, publicId: row.proposalPublicId, title: row.proposalTitle },
    reviewer: { userId: row.reviewerUserId, displayName: row.reviewerName, email: row.reviewerEmail },
    conflict: conflictProjection(row),
  };
}

function lifecycleProjection(row: AssignmentRow) {
  return {
    id: row.id,
    invitationStatus: row.invitationStatus,
    respondedAt: row.respondedAt ?? row.conflictDeclaredAt ?? row.createdAt,
    reason: row.responseReason,
    conflict: conflictProjection(row),
  };
}

async function scorecardProjection(context: Context<AppBindings>, row: ReviewRow) {
  const { results } = await context.env.DB.prepare(
    `SELECT score.criterion_id AS criterionId, criterion.criterion_key AS key,
      criterion.label, score.score
    FROM current_review_criterion_scores AS score
    INNER JOIN review_criteria AS criterion ON criterion.id = score.criterion_id
      AND criterion.event_id = score.event_id
    WHERE score.review_id = ? AND score.event_id = ?
    ORDER BY criterion.sort_order, criterion.id`,
  ).bind(row.id, row.eventId).all<CriterionScoreRow>();
  const plan = await evaluationPlanByVersion(context.env.DB, row.eventId, row.reviewPlanVersionId);
  return {
    id: row.id,
    revisionNumber: row.revisionNumber,
    originality: row.originality,
    relevance: row.relevance,
    evaluationPlanVersion: plan?.versionNumber ?? null,
    criterionScores: results,
    weightedScore: row.weightedScoreMilli === null ? null : row.weightedScoreMilli / 1000,
    recommendation: row.recommendation,
    comment: row.comment,
    submittedAt: row.submittedAt,
    correctedAt: row.correctedAt,
  };
}

async function sameScorecard(
  context: Context<AppBindings>,
  row: ReviewRow,
  input: { originality: number; relevance: number; recommendation: string; comment: string }
    | { criterionScores: Array<{ criterionId: string; score: number }>; recommendation: string; comment: string },
) {
  if (row.recommendation !== input.recommendation || row.comment !== input.comment.trim()) return false;
  if ("originality" in input) {
    return row.reviewPlanVersionId === null
      && row.originality === input.originality && row.relevance === input.relevance;
  }
  const { results } = await context.env.DB.prepare(
    "SELECT criterion_id AS criterionId, score FROM current_review_criterion_scores WHERE review_id = ? ORDER BY criterion_id",
  ).bind(row.id).all<{ criterionId: string; score: number }>();
  const expected = [...input.criterionScores].sort((a, b) => a.criterionId.localeCompare(b.criterionId));
  return JSON.stringify(results) === JSON.stringify(expected);
}

function sameAssignment(
  row: AssignmentRow,
  input: { blind: boolean; dueAt?: string | null; reviewRoundId?: string | null },
) {
  return row.blind === (input.blind ? 1 : 0) && row.dueAt === (input.dueAt ?? null)
    && row.reviewRoundId === (input.reviewRoundId ?? null);
}

async function findAssignment(
  context: Context<AppBindings>,
  assignmentId: string,
): Promise<AssignmentRow | null> {
  return context.env.DB.prepare(
    `${ASSIGNMENT_SELECT}
    WHERE assignment.id = ? AND assignment.event_id = ?
    LIMIT 1`,
  ).bind(assignmentId, context.get("authEventId")).first<AssignmentRow>();
}

async function findLatestProposalReviewerAssignment(
  context: Context<AppBindings>,
  proposalId: string,
  reviewerUserId: string,
  reviewRoundId: string | null,
): Promise<AssignmentRow | null> {
  return context.env.DB.prepare(
    `${ASSIGNMENT_SELECT}
    WHERE assignment.event_id = ? AND assignment.proposal_id = ?
      AND assignment.reviewer_user_id = ?
      AND assignment.review_round_id IS ?
    ORDER BY assignment.round DESC
    LIMIT 1`,
  ).bind(
    context.get("authEventId"),
    proposalId,
    reviewerUserId,
    reviewRoundId,
  ).first<AssignmentRow>();
}

async function nextAssignmentRetry(
  context: Context<AppBindings>,
  proposalId: string,
  reviewerUserId: string,
) {
  return await context.env.DB.prepare(
    `SELECT COALESCE(MAX(round), 0) + 1 AS nextRound
    FROM review_assignments
    WHERE event_id = ? AND proposal_id = ? AND reviewer_user_id = ?`,
  ).bind(context.get("authEventId"), proposalId, reviewerUserId).first<number>("nextRound") ?? 1;
}

async function loadAssignmentRetries(context: Context<AppBindings>, reviewRoundId: string, track: string | null) {
  const { results } = await context.env.DB.prepare(
    `SELECT assignment.proposal_id AS proposalId, assignment.reviewer_user_id AS reviewerUserId,
      MAX(assignment.round) + 1 AS nextRound
    FROM review_assignments AS assignment
    INNER JOIN review_round_reviewers AS pool
      ON pool.review_round_id = ?2 AND pool.reviewer_user_id = assignment.reviewer_user_id
    INNER JOIN proposals AS proposal
      ON proposal.id = assignment.proposal_id AND proposal.event_id = assignment.event_id
      AND proposal.status IN ('submitted', 'in_review', 'decided')
      AND (?3 IS NULL OR proposal.track = ?3)
    WHERE assignment.event_id = ?1
    GROUP BY assignment.proposal_id, assignment.reviewer_user_id
    /* auto-assign retry rounds */`,
  ).bind(context.get("authEventId"), reviewRoundId, track).all<{
    proposalId: string;
    reviewerUserId: string;
    nextRound: number;
  }>();
  return new Map(results.map((row) => [autoAssignPairKey(row.proposalId, row.reviewerUserId), row.nextRound]));
}

async function findReview(context: Context<AppBindings>, assignmentId: string) {
  return context.env.DB.prepare(
    `SELECT
      id,
      base_review_id AS baseReviewId,
      event_id AS eventId,
      assignment_id AS assignmentId,
      originality_score AS originality,
      relevance_score AS relevance,
      recommendation,
      comment,
      submitted_at AS submittedAt,
      corrected_at AS correctedAt,
      revision_number AS revisionNumber,
      review_plan_version_id AS reviewPlanVersionId,
      weighted_score_milli AS weightedScoreMilli
    FROM current_reviews
    WHERE assignment_id = ? AND event_id = ?
    LIMIT 1`,
  ).bind(assignmentId, context.get("authEventId")).first<ReviewRow>();
}

interface RoundRow {
  id: string;
  name: string;
  opensAt: string;
  closesAt: string;
  blindDefault: number;
  position: number;
  updatedAt: string;
}

// RAISE(ABORT, ...) text this module classifies; the migrations that currently
// own each trigger and the schema suite pin these strings so a reworded trigger
// fails tests instead of turning a handled rejection into a 500.
const TRIGGER_MESSAGES = {
  poolEntryNotReviewer: /requires an event reviewer/i,
  poolEntryActiveAssignments: /active assignments cannot be removed/i,
  roundPositionRace: /UNIQUE constraint failed: review_rounds\.event_id, review_rounds\.position/i,
  reviewNotAllowed: /review must belong to one accepted active event assignment without conflict and cannot be self-review/i,
  correctionNotAllowed: /review correction requires its assigned reviewer in an open event round/i,
  correctionSequenceRace: /review correction revision must be the next sequence|UNIQUE constraint failed: review_corrections\.review_id, review_corrections\.revision_number/i,
} as const;

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function roundWindowState(round: Pick<RoundRow, "opensAt" | "closesAt">, now: string) {
  if (now < round.opensAt) return "upcoming" as const;
  if (now >= round.closesAt) return "closed" as const;
  return "open" as const;
}

async function findRound(context: Context<AppBindings>, roundId: string): Promise<RoundRow | null> {
  return context.env.DB.prepare(
    `SELECT id, name, opens_at AS opensAt, closes_at AS closesAt,
      blind_default AS blindDefault, position, updated_at AS updatedAt
    FROM review_rounds WHERE id = ? AND event_id = ? LIMIT 1`,
  ).bind(roundId, context.get("authEventId")).first<RoundRow>();
}

async function listRounds(context: Context<AppBindings>) {
  const now = utcNow();
  const { results } = await context.env.DB.prepare(
    `SELECT round.id, round.name, round.opens_at AS opensAt, round.closes_at AS closesAt,
      round.blind_default AS blindDefault, round.position, round.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM review_round_reviewers AS pool
        WHERE pool.review_round_id = round.id) AS poolSize,
      EXISTS (SELECT 1 FROM review_plans AS plan
        WHERE plan.review_round_id = round.id AND plan.active_version_id IS NOT NULL) AS hasActivePlan
    FROM review_rounds AS round
    WHERE round.event_id = ?
    ORDER BY round.position ASC, round.id ASC`,
  ).bind(context.get("authEventId")).all<RoundRow & { poolSize: number; hasActivePlan: number }>();
  return results.map((round) => ({
    id: round.id,
    name: round.name,
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    blindDefault: round.blindDefault === 1,
    position: round.position,
    windowState: roundWindowState(round, now),
    poolSize: round.poolSize,
    hasActivePlan: round.hasActivePlan === 1,
    updatedAt: round.updatedAt,
  }));
}

async function poolMembers(context: Context<AppBindings>, roundId: string) {
  const { results } = await context.env.DB.prepare(
    `SELECT user.id AS userId, user.display_name AS displayName, lower(trim(user.email)) AS email
    FROM review_round_reviewers AS pool
    INNER JOIN users AS user ON user.id = pool.reviewer_user_id
    WHERE pool.review_round_id = ?
    ORDER BY user.display_name COLLATE NOCASE ASC, user.id ASC`,
  ).bind(roundId).all<ReviewerRow>();
  return results.map((member) => ({ ...member }));
}

async function resolvePlanRoundId(context: Context<AppBindings>): Promise<string | null | Response> {
  const roundId = context.req.query("roundId");
  if (!roundId) return null;
  const round = await findRound(context, roundId);
  if (!round) return errorResponse(context, 404, "REVIEW_ROUND_NOT_FOUND", "The requested review round does not exist.");
  return round.id;
}

type AutoAssignBlockReason = "self_review" | "conflict" | "already_assigned";

interface AutoAssignBlockers {
  presenters: Set<string>;
  conflicts: Set<string>;
  activeAssignments: Set<string>;
}

function autoAssignPairKey(proposalId: string, reviewerUserId: string) {
  return `${proposalId}\u0000${reviewerUserId}`;
}

async function loadAutoAssignBlockers(
  context: Context<AppBindings>,
  reviewRoundId: string,
): Promise<AutoAssignBlockers> {
  const eventId = context.get("authEventId");
  const [presenters, conflicts, activeAssignments] = await Promise.all([
    context.env.DB.prepare(
      `/* auto-assign presenter blockers */
      SELECT presenter.proposal_id AS proposalId, speaker.user_id AS reviewerUserId
      FROM proposal_presenters AS presenter
      INNER JOIN speakers AS speaker
        ON speaker.id = presenter.speaker_id AND speaker.event_id = presenter.event_id
      WHERE presenter.event_id = ? AND speaker.user_id IS NOT NULL`,
    ).bind(eventId).all<{ proposalId: string; reviewerUserId: string }>(),
    context.env.DB.prepare(
      `/* auto-assign conflict blockers */
      SELECT proposal_id AS proposalId, reviewer_user_id AS reviewerUserId
      FROM reviewer_conflicts WHERE event_id = ?`,
    ).bind(eventId).all<{ proposalId: string; reviewerUserId: string }>(),
    context.env.DB.prepare(
      `/* auto-assign active-assignment blockers */
      SELECT proposal_id AS proposalId, reviewer_user_id AS reviewerUserId
      FROM review_assignments
      WHERE event_id = ? AND review_round_id = ? AND state = 'assigned'`,
    ).bind(eventId, reviewRoundId).all<{ proposalId: string; reviewerUserId: string }>(),
  ]);
  const pairSet = (rows: Array<{ proposalId: string; reviewerUserId: string }>) =>
    new Set(rows.map((row) => autoAssignPairKey(row.proposalId, row.reviewerUserId)));
  return {
    presenters: pairSet(presenters.results),
    conflicts: pairSet(conflicts.results),
    activeAssignments: pairSet(activeAssignments.results),
  };
}

function autoAssignBlocker(
  blockers: AutoAssignBlockers,
  proposal: ProposalForAssignmentRow,
  reviewerUserId: string,
): AutoAssignBlockReason | null {
  if (proposal.ownerUserId === reviewerUserId) return "self_review";
  const pairKey = autoAssignPairKey(proposal.id, reviewerUserId);
  if (blockers.presenters.has(pairKey)) return "self_review";
  if (blockers.conflicts.has(pairKey)) return "conflict";
  return blockers.activeAssignments.has(pairKey) ? "already_assigned" : null;
}

export function createReviewRoutes() {
  const routes = new Hono<AppBindings>();

  routes.use("/events/:eventSlug/cfp/reviewers", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/review-plan", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/review-rounds", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/review-rounds/*", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/reviews/progress", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/reviews/reviewer-progress", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/reviews/reminders", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/reviews/export.csv", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/proposals/:proposalId/assignments", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/proposals/:proposalId/reviews", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/cfp/assignments/:assignmentId/revoke", requireEventRole("organizer"));
  routes.use("/events/:eventSlug/review/assignments", requireEventRole("reviewer"));
  routes.use("/events/:eventSlug/review/assignments/*", requireEventRole("reviewer"));

  routes.get("/events/:eventSlug/cfp/reviewers", async (context) => {
    const { results } = await context.env.DB.prepare(
      `SELECT
        user.id AS userId,
        user.display_name AS displayName,
        lower(trim(user.email)) AS email
      FROM event_memberships AS membership
      INNER JOIN users AS user ON user.id = membership.user_id
      WHERE membership.event_id = ? AND membership.role = 'reviewer'
      ORDER BY user.display_name COLLATE NOCASE ASC, user.id ASC`,
    ).bind(context.get("authEventId")).all<ReviewerRow>();

    return contractData(context, reviewerMembershipListResponseSchema, {
      reviewers: results.map((reviewer) => ({
        userId: reviewer.userId,
        displayName: reviewer.displayName,
        email: reviewer.email,
      })),
    });
  });

  routes.get("/events/:eventSlug/cfp/review-plan", async (context) => {
    const roundId = await resolvePlanRoundId(context);
    if (roundId instanceof Response) return roundId;
    const plan = await activeEvaluationPlan(context.env.DB, context.get("authEventId"), roundId);
    if (!plan) return errorResponse(context, 404, "REVIEW_PLAN_NOT_FOUND", "No evaluation plan has been configured for this event.");
    return contractData(context, evaluationPlanVersionSchema, plan);
  });

  routes.put("/events/:eventSlug/cfp/review-plan", async (context) => {
    const roundId = await resolvePlanRoundId(context);
    if (roundId instanceof Response) return roundId;
    const input = await parseJson(context, evaluationPlanWriteSchema);
    if (input instanceof Response) return input;
    let plan;
    try {
      plan = await createEvaluationPlanVersion(
        context.env.DB,
        context.get("authEventId"),
        context.get("authUserId"),
        input,
        roundId,
      );
    } catch (error) {
      if (error instanceof EvaluationPlanConflictError) {
        return errorResponse(context, 409, "REVIEW_PLAN_CONFLICT", "The active evaluation plan changed. Reload it before creating another version.");
      }
      throw error;
    }
    return contractData(context, evaluationPlanVersionSchema, plan, 201);
  });

  routes.get("/events/:eventSlug/cfp/review-rounds", async (context) => {
    const rounds = await listRounds(context);
    return contractData(context, reviewRoundListResponseSchema, { rounds });
  });

  routes.post("/events/:eventSlug/cfp/review-rounds", async (context) => {
    const input = await parseJson(context, reviewRoundWriteSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const id = crypto.randomUUID();
    const now = utcNow();
    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
      const position = await context.env.DB.prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM review_rounds WHERE event_id = ?",
      ).bind(eventId).first<number>("next") ?? 0;
      try {
        await context.env.DB.prepare(
          `INSERT INTO review_rounds (
            id, event_id, name, opens_at, closes_at, blind_default, position,
            created_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id, eventId, input.name, input.opensAt, input.closesAt,
          input.blindDefault ? 1 : 0, position, context.get("authUserId"), now, now,
        ).run();
        inserted = true;
      } catch (error) {
        const message = constraintMessage(error);
        if (!TRIGGER_MESSAGES.roundPositionRace.test(message)) throw error;
      }
    }
    if (!inserted) {
      return errorResponse(context, 409, "REVIEW_ROUND_CONFLICT", "Another round was created at the same time. Try again.");
    }
    const rounds = await listRounds(context);
    const round = rounds.find((candidate) => candidate.id === id);
    return contractData(context, reviewRoundResponseSchema, round!, 201);
  });

  routes.patch("/events/:eventSlug/cfp/review-rounds/:roundId", async (context) => {
    const input = await parseJson(context, reviewRoundUpdateSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const roundId = context.req.param("roundId");
    const existing = await context.env.DB.prepare(
      "SELECT id, updated_at AS updatedAt FROM review_rounds WHERE id = ? AND event_id = ? LIMIT 1",
    ).bind(roundId, eventId).first<{ id: string; updatedAt: string }>();
    if (!existing) return errorResponse(context, 404, "REVIEW_ROUND_NOT_FOUND", "The requested review round does not exist.");
    if (existing.updatedAt !== input.expectedUpdatedAt) {
      return errorResponse(context, 409, "REVIEW_ROUND_STALE", "The round changed since it was loaded. Reload it before saving.");
    }
    const now = utcNow();
    const updated = await context.env.DB.prepare(
      `UPDATE review_rounds
      SET name = ?, opens_at = ?, closes_at = ?, blind_default = ?,
        updated_by_user_id = ?, updated_at = CASE
          WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
          ELSE ?
        END
      WHERE id = ? AND event_id = ? AND updated_at = ?`,
    ).bind(
      input.name, input.opensAt, input.closesAt, input.blindDefault ? 1 : 0,
      context.get("authUserId"), now, now, roundId, eventId, input.expectedUpdatedAt,
    ).run();
    if (updated.meta.changes === 0) {
      return errorResponse(context, 409, "REVIEW_ROUND_STALE", "The round changed since it was loaded. Reload it before saving.");
    }
    const rounds = await listRounds(context);
    return contractData(context, reviewRoundResponseSchema, rounds.find((candidate) => candidate.id === roundId)!);
  });

  routes.get("/events/:eventSlug/cfp/review-rounds/:roundId/pool", async (context) => {
    const round = await findRound(context, context.req.param("roundId"));
    if (!round) return errorResponse(context, 404, "REVIEW_ROUND_NOT_FOUND", "The requested review round does not exist.");
    return contractData(context, reviewRoundPoolResponseSchema, {
      roundId: round.id,
      reviewers: await poolMembers(context, round.id),
      rejected: [],
    });
  });

  routes.put("/events/:eventSlug/cfp/review-rounds/:roundId/pool", async (context) => {
    const input = await parseJson(context, reviewRoundPoolWriteSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const round = await findRound(context, context.req.param("roundId"));
    if (!round) return errorResponse(context, 404, "REVIEW_ROUND_NOT_FOUND", "The requested review round does not exist.");
    const desired = [...new Set(input.reviewerUserIds)];
    const current = await poolMembers(context, round.id);
    const currentIds = new Set(current.map((member) => member.userId));
    const rejected: Array<{ userId: string; reason: "not_a_reviewer" | "unknown_user" | "active_assignments" }> = [];
    const now = utcNow();
    for (const userId of desired.filter((candidate) => !currentIds.has(candidate))) {
      const known = await context.env.DB.prepare(
        "SELECT 1 AS found FROM event_memberships WHERE event_id = ? AND user_id = ? LIMIT 1",
      ).bind(eventId, userId).first<{ found: number }>();
      if (!known) {
        rejected.push({ userId, reason: "unknown_user" });
        continue;
      }
      try {
        await context.env.DB.prepare(
          `INSERT INTO review_round_reviewers (id, event_id, review_round_id, reviewer_user_id, added_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), eventId, round.id, userId, context.get("authUserId"), now).run();
      } catch (error) {
        const message = constraintMessage(error);
        if (TRIGGER_MESSAGES.poolEntryNotReviewer.test(message)) rejected.push({ userId, reason: "not_a_reviewer" });
        else throw error;
      }
    }
    const desiredIds = new Set(desired);
    for (const member of current.filter((candidate) => !desiredIds.has(candidate.userId))) {
      try {
        await context.env.DB.prepare(
          "DELETE FROM review_round_reviewers WHERE review_round_id = ? AND reviewer_user_id = ?",
        ).bind(round.id, member.userId).run();
      } catch (error) {
        const message = constraintMessage(error);
        if (TRIGGER_MESSAGES.poolEntryActiveAssignments.test(message)) {
          rejected.push({ userId: member.userId, reason: "active_assignments" });
        } else throw error;
      }
    }
    return contractData(context, reviewRoundPoolResponseSchema, {
      roundId: round.id,
      reviewers: await poolMembers(context, round.id),
      rejected,
    });
  });

  routes.post("/events/:eventSlug/cfp/review-rounds/:roundId/assignments/auto", async (context) => {
    const input = await parseJson(context, reviewAutoAssignRequestSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const round = await findRound(context, context.req.param("roundId"));
    if (!round) return errorResponse(context, 404, "REVIEW_ROUND_NOT_FOUND", "The requested review round does not exist.");
    if (roundWindowState(round, utcNow()) !== "open") {
      return errorResponse(context, 409, "REVIEW_ROUND_NOT_OPEN", "Assignments can only be created while the round window is open.");
    }
    const plan = await activeEvaluationPlan(context.env.DB, eventId, round.id);
    const pool = await context.env.DB.prepare(
      `SELECT pool.reviewer_user_id AS userId, user.display_name AS displayName,
        (SELECT COUNT(*) FROM review_assignments AS assignment
          WHERE assignment.review_round_id = pool.review_round_id
            AND assignment.reviewer_user_id = pool.reviewer_user_id
            AND assignment.state = 'assigned'
            AND NOT EXISTS (
              SELECT 1 FROM review_assignment_actions AS action
              WHERE action.assignment_id = assignment.id AND action.action IN ('declined', 'recused')
            )
            AND NOT EXISTS (
              SELECT 1 FROM reviewer_conflicts AS conflict WHERE conflict.assignment_id = assignment.id
            )) AS activeLoad
      FROM review_round_reviewers AS pool
      INNER JOIN users AS user ON user.id = pool.reviewer_user_id
      WHERE pool.review_round_id = ?
      ORDER BY user.display_name COLLATE NOCASE ASC, pool.reviewer_user_id ASC`,
    ).bind(round.id).all<{ userId: string; displayName: string; activeLoad: number }>();
    const reviewers = pool.results.map((row) => ({ ...row }));
    const candidateBatchSize = 250;
    const { results: candidateRows } = await context.env.DB.prepare(
      `SELECT proposal.id, proposal.owner_user_id AS ownerUserId, proposal.status
      FROM proposals AS proposal
      WHERE proposal.event_id = ?1
        AND proposal.status IN ('submitted', 'in_review', 'decided')
        AND (?2 IS NULL OR proposal.track = ?2)
        AND NOT EXISTS (
          SELECT 1 FROM review_assignments AS assignment
          WHERE assignment.proposal_id = proposal.id
            AND assignment.review_round_id = ?3
            AND assignment.state = 'assigned'
            AND NOT EXISTS (
              SELECT 1 FROM review_assignment_actions AS action
              WHERE action.assignment_id = assignment.id AND action.action IN ('declined', 'recused')
            )
            AND NOT EXISTS (
              SELECT 1 FROM reviewer_conflicts AS conflict WHERE conflict.assignment_id = assignment.id
            )
        )
      ORDER BY proposal.created_at ASC, proposal.id ASC
      LIMIT ?4`,
    ).bind(eventId, input.track ?? null, round.id, candidateBatchSize + 1).all<ProposalForAssignmentRow>();
    const hasMore = candidateRows.length > candidateBatchSize;
    const candidates = candidateRows.slice(0, candidateBatchSize);
    const created: Array<{ assignmentId: string; proposalId: string; reviewerUserId: string }> = [];
    const skipped: Array<{ proposalId: string; reviewerUserId: string | null; reason:
      "conflict" | "self_review" | "already_assigned" | "reviewer_at_cap" | "no_pool_capacity" | "insert_failed" }> = [];
    const blockers = await loadAutoAssignBlockers(context, round.id);
    const assignmentRetries = await loadAssignmentRetries(context, round.id, input.track ?? null);
    for (const proposal of candidates) {
      const eligible = [...reviewers].sort((a, b) =>
        a.activeLoad - b.activeLoad || a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
      let assigned = false;
      let sawUnderCap = false;
      const blockedPairs: Array<{ reviewerUserId: string; reason: AutoAssignBlockReason }> = [];
      for (const reviewer of eligible) {
        if (input.perReviewerCap !== undefined && reviewer.activeLoad >= input.perReviewerCap) continue;
        sawUnderCap = true;
        const blocked = autoAssignBlocker(blockers, proposal, reviewer.userId);
        if (blocked) {
          blockedPairs.push({ reviewerUserId: reviewer.userId, reason: blocked });
          continue;
        }
        const id = crypto.randomUUID();
        const now = utcNow();
        const pairKey = autoAssignPairKey(proposal.id, reviewer.userId);
        const assignmentRetry = assignmentRetries.get(pairKey) ?? 1;
        try {
          await context.env.DB.batch([
            context.env.DB.prepare(`INSERT INTO review_assignments (
              id, event_id, proposal_id, reviewer_user_id, created_by_user_id,
              round, blind, state, due_at, created_at, updated_at, review_plan_version_id,
              requires_response, review_round_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, 1, ?)`,
            ).bind(
              id, eventId, proposal.id, reviewer.userId, context.get("authUserId"),
              assignmentRetry,
              (input.blind ?? round.blindDefault === 1) ? 1 : 0, input.dueAt ?? null, now, now,
              plan?.versionId ?? null, round.id,
            ),
            context.env.DB.prepare(`UPDATE proposals SET status = 'in_review', updated_at = CASE
                WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second') ELSE ? END
              WHERE id = ? AND event_id = ? AND status = 'submitted'`)
              .bind(now, now, proposal.id, eventId),
          ]);
        } catch (error) {
          console.error("Review auto-assignment batch failed", { requestId: context.get("requestId"), error });
          skipped.push({ proposalId: proposal.id, reviewerUserId: reviewer.userId, reason: "insert_failed" });
          continue;
        }
        reviewer.activeLoad += 1;
        blockers.activeAssignments.add(pairKey);
        created.push({ assignmentId: id, proposalId: proposal.id, reviewerUserId: reviewer.userId });
        assigned = true;
        break;
      }
      if (!assigned) {
        if (blockedPairs.length > 0) {
          for (const pair of blockedPairs) {
            skipped.push({ proposalId: proposal.id, reviewerUserId: pair.reviewerUserId, reason: pair.reason });
          }
        } else {
          skipped.push({
            proposalId: proposal.id,
            reviewerUserId: null,
            reason: reviewers.length > 0 && !sawUnderCap ? "reviewer_at_cap" : "no_pool_capacity",
          });
        }
      }
    }
    return contractData(context, reviewAutoAssignResultSchema, { created, skipped, hasMore });
  });

  routes.get("/events/:eventSlug/cfp/reviews/reviewer-progress", async (context) => {
    const eventId = context.get("authEventId");
    const requestedRoundId = context.req.query("roundId") ?? null;
    if (requestedRoundId) {
      const round = await findRound(context, requestedRoundId);
      if (!round) return errorResponse(context, 404, "REVIEW_ROUND_NOT_FOUND", "The requested review round does not exist.");
    }
    const now = utcNow();
    const { results } = await context.env.DB.prepare(
      `SELECT
        user.id AS userId,
        user.display_name AS displayName,
        lower(trim(user.email)) AS email,
        COUNT(assignment.id) AS assignedCount,
        COUNT(review.id) AS completedCount,
        SUM(CASE WHEN review.id IS NULL AND assignment.due_at IS NOT NULL AND assignment.due_at < ?1
          THEN 1 ELSE 0 END) AS overdueCount
      FROM event_memberships AS membership
      INNER JOIN users AS user ON user.id = membership.user_id
      LEFT JOIN review_assignments AS assignment
        ON assignment.event_id = membership.event_id
        AND assignment.reviewer_user_id = membership.user_id
        AND assignment.state = 'assigned'
        AND (?2 IS NULL OR assignment.review_round_id IS ?2)
        AND NOT EXISTS (
          SELECT 1 FROM review_assignment_actions AS action
          WHERE action.assignment_id = assignment.id AND action.action IN ('declined', 'recused')
        )
        AND NOT EXISTS (
          SELECT 1 FROM reviewer_conflicts AS conflict WHERE conflict.assignment_id = assignment.id
        )
      LEFT JOIN current_reviews AS review ON review.assignment_id = assignment.id
        AND review.event_id = assignment.event_id
      WHERE membership.event_id = ?3 AND membership.role = 'reviewer'
        AND (?2 IS NULL OR EXISTS (
          SELECT 1 FROM review_round_reviewers AS pool
          WHERE pool.review_round_id = ?2 AND pool.reviewer_user_id = membership.user_id
        ))
      GROUP BY user.id, user.display_name, user.email
      ORDER BY user.display_name COLLATE NOCASE ASC, user.id ASC`,
    ).bind(now, requestedRoundId, eventId).all<{
      userId: string; displayName: string; email: string;
      assignedCount: number; completedCount: number; overdueCount: number | null;
    }>();
    return contractData(context, reviewerProgressResponseSchema, {
      roundId: requestedRoundId,
      reviewers: results.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        email: row.email,
        assignedCount: row.assignedCount,
        completedCount: row.completedCount,
        overdueCount: row.overdueCount ?? 0,
      })),
    });
  });

  routes.post("/events/:eventSlug/cfp/reviews/reminders", async (context) => {
    const input = await parseJson(context, reviewerReminderEnqueueSchema);
    if (input instanceof Response) return input;
    try {
      const response = await enqueueReviewerReminder(
        context.env.DB,
        context.get("authEventId"),
        context.get("authUserId"),
        input,
        utcNow(),
      );
      return contractData(context, reviewerReminderResponseSchema, response, 201);
    } catch (error) {
      if (error instanceof ReviewerReminderNotFoundError) {
        return errorResponse(context, 404, "REVIEWER_NOT_FOUND", "The requested reviewer does not exist for this event.");
      }
      if (error instanceof ReviewerReminderTemplateNotFoundError) {
        return errorResponse(context, 404, "REMINDER_TEMPLATE_NOT_FOUND", "The requested reminder template does not exist.");
      }
      if (error instanceof ReviewerReminderIneligibleError) {
        return errorResponse(context, 409, "REMINDER_NOT_ELIGIBLE", "This reviewer has no pending review assignments to remind about.");
      }
      if (error instanceof ReviewerReminderIdempotencyConflictError) {
        return errorResponse(context, 409, "REMINDER_IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different reminder content.");
      }
      if (error instanceof ReviewerReminderAuthorizationError) {
        return errorResponse(context, 403, "REMINDER_NOT_AUTHORIZED", "Only a same-event organizer can queue reviewer reminders.");
      }
      throw error;
    }
  });

  routes.get("/events/:eventSlug/cfp/reviews/progress", async (context) => {
    const results = await listProposalReviewResults(context.env.DB, context.get("authEventId"));

    return contractData(context, organizerProposalReviewProgressResponseSchema, {
      proposals: results.map((row) => ({
        proposalId: row.proposalId,
        publicId: row.publicId,
        title: row.title,
        track: row.track,
        format: row.format,
        assignedCount: row.assignedCount,
        completedCount: row.completedCount,
        averageScore: row.averageScore,
        recommendations: {
          accept: row.acceptCount,
          discuss: row.discussCount,
          reject: row.rejectCount,
        },
      })),
    });
  });

  routes.get("/events/:eventSlug/cfp/reviews/export.csv", async (context) => {
    const results = await listProposalReviewResults(context.env.DB, context.get("authEventId"));
    const eventSlug = context.req.param("eventSlug").replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "event";
    return context.body(await proposalReviewResultsCsv(context.env.DB, context.get("authEventId"), results), 200, {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${eventSlug}-review-results.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
  });

  routes.post("/events/:eventSlug/cfp/proposals/:proposalId/assignments", async (context) => {
    const input = await parseJson(context, organizerReviewAssignmentCreateSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const proposalId = context.req.param("proposalId");

    const proposal = await context.env.DB.prepare(
      `SELECT id, owner_user_id AS ownerUserId, status
      FROM proposals WHERE id = ? AND event_id = ? LIMIT 1`,
    ).bind(proposalId, eventId).first<ProposalForAssignmentRow>();
    if (!proposal) {
      return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    }

    const reviewRoundId = input.reviewRoundId ?? null;
    const existing = await findLatestProposalReviewerAssignment(
      context,
      proposal.id,
      input.reviewerUserId,
      reviewRoundId,
    );
    if (existing) {
      if (existing.state === "assigned") {
        if (existing.conflictCategory) {
          return errorResponse(context, 409, "REVIEWER_CONFLICT_DECLARED", "This reviewer declared a conflict with this proposal and cannot be assigned.");
        }
        if (existing.invitationStatus === "declined" || existing.invitationStatus === "recused") {
          return errorResponse(context, 409, "ASSIGNMENT_INACTIVE", "Revoke the declined or recused assignment before creating a new round.");
        }
        if (!sameAssignment(existing, input)) {
          return errorResponse(context, 409, "ASSIGNMENT_ALREADY_EXISTS", "This reviewer already has an assignment with different settings.");
        }
        if (proposal.status === "submitted") {
          await context.env.DB.prepare(
            `UPDATE proposals
            SET status = 'in_review', updated_at = CASE
              WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
              ELSE ?
            END
            WHERE id = ? AND event_id = ? AND status = 'submitted'`,
          ).bind(existing.createdAt, existing.createdAt, proposal.id, eventId).run();
        }
        return contractData(context, reviewAssignmentResponseSchema, assignmentProjection(existing));
      }
    }

    if (proposal.status === "decided" && !reviewRoundId) {
      return errorResponse(context, 409, "REVIEW_ROUND_REQUIRED_AFTER_DECISION", "Choose an open named review round to collect additional input after a decision.");
    }
    if (proposal.status !== "submitted" && proposal.status !== "in_review" && proposal.status !== "decided") {
      return errorResponse(context, 409, "PROPOSAL_NOT_REVIEWABLE", "Only submitted proposals can be assigned for review.");
    }

    const reviewer = await context.env.DB.prepare(
      `SELECT user.id AS userId
      FROM event_memberships AS membership
      INNER JOIN users AS user ON user.id = membership.user_id
      WHERE membership.event_id = ? AND membership.user_id = ? AND membership.role = 'reviewer'
      LIMIT 1`,
    ).bind(eventId, input.reviewerUserId).first<{ userId: string }>();
    if (!reviewer) {
      return errorResponse(context, 404, "REVIEWER_NOT_FOUND", "The requested reviewer does not exist for this event.");
    }
    const presenter = await context.env.DB.prepare(
      `SELECT 1 AS found
      FROM proposal_presenters AS presenter
      INNER JOIN speakers AS speaker
        ON speaker.id = presenter.speaker_id AND speaker.event_id = presenter.event_id
      WHERE presenter.event_id = ? AND presenter.proposal_id = ? AND speaker.user_id = ?
      LIMIT 1`,
    ).bind(eventId, proposal.id, reviewer.userId).first<{ found: number }>();
    if (proposal.ownerUserId === reviewer.userId || presenter) {
      return errorResponse(context, 409, "SELF_REVIEW_NOT_ALLOWED", "A proposal owner cannot review their own proposal.");
    }
    const declaredConflict = await context.env.DB.prepare(
      `SELECT 1 AS found FROM reviewer_conflicts
      WHERE event_id = ? AND proposal_id = ? AND reviewer_user_id = ? LIMIT 1`,
    ).bind(eventId, proposal.id, reviewer.userId).first<{ found: number }>();
    if (declaredConflict) {
      return errorResponse(context, 409, "REVIEWER_CONFLICT_DECLARED", "This reviewer declared a conflict with this proposal and cannot be assigned.");
    }

    const id = crypto.randomUUID();
    const round = await nextAssignmentRetry(context, proposal.id, reviewer.userId);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    if (reviewRoundId) {
      const reviewRound = await findRound(context, reviewRoundId);
      if (!reviewRound) {
        return errorResponse(context, 404, "REVIEW_ROUND_NOT_FOUND", "The requested review round does not exist.");
      }
      if (roundWindowState(reviewRound, now) !== "open") {
        return errorResponse(context, 409, "REVIEW_ROUND_NOT_OPEN", "Assignments can only be created while the round window is open.");
      }
      const poolEntry = await context.env.DB.prepare(
        "SELECT 1 AS found FROM review_round_reviewers WHERE review_round_id = ? AND reviewer_user_id = ? LIMIT 1",
      ).bind(reviewRoundId, reviewer.userId).first<{ found: number }>();
      if (!poolEntry) {
        return errorResponse(context, 409, "REVIEWER_NOT_IN_POOL", "Add this reviewer to the round pool before assigning within the round.");
      }
    }
    const plan = await activeEvaluationPlan(context.env.DB, eventId, reviewRoundId);
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE proposals
          SET status = 'in_review', updated_at = CASE
            WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
            ELSE ?
          END
          WHERE id = ? AND event_id = ? AND status = 'submitted'`,
        ).bind(now, now, proposal.id, eventId),
        context.env.DB.prepare(
          `INSERT INTO review_assignments (
            id, event_id, proposal_id, reviewer_user_id, created_by_user_id,
            round, blind, state, due_at, created_at, updated_at, review_plan_version_id,
            requires_response, review_round_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, 1, ?)`,
        ).bind(
          id,
          eventId,
          proposal.id,
          reviewer.userId,
          context.get("authUserId"),
          round,
          input.blind ? 1 : 0,
          input.dueAt ?? null,
          now,
          now,
          plan?.versionId ?? null,
          reviewRoundId,
        ),
      ]);
    } catch (error) {
      const raced = await findLatestProposalReviewerAssignment(
        context,
        proposal.id,
        reviewer.userId,
        reviewRoundId,
      );
      if (raced?.state === "assigned" && sameAssignment(raced, input)) {
        return contractData(context, reviewAssignmentResponseSchema, assignmentProjection(raced));
      }
      if (raced?.state === "assigned") {
        return errorResponse(context, 409, "ASSIGNMENT_ALREADY_EXISTS", "This reviewer already has an assignment with different settings.");
      }
      console.error("Review assignment insert failed", { requestId: context.get("requestId"), error });
      throw error;
    }

    const assignment = await findAssignment(context, id);
    return contractData(context, reviewAssignmentResponseSchema, assignmentProjection(assignment!), 201);
  });

  routes.post("/events/:eventSlug/cfp/assignments/:assignmentId/revoke", async (context) => {
    const assignment = await findAssignment(context, context.req.param("assignmentId"));
    if (!assignment) {
      return errorResponse(context, 404, "ASSIGNMENT_NOT_FOUND", "The requested reviewer assignment does not exist.");
    }
    if (assignment.reviewId) {
      return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "A completed reviewer assignment cannot be revoked.");
    }
    if (assignment.state === "revoked") {
      if (!assignment.revokedAt) {
        return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION", "The revoked assignment is missing its audit timestamp.");
      }
      return contractData(context, reviewAssignmentRevokeResponseSchema, {
        id: assignment.id,
        status: "revoked",
        revokedAt: assignment.revokedAt,
      });
    }

    const now = new Date().toISOString();
    try {
      await context.env.DB.prepare(
        `UPDATE review_assignments
        SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND state = 'assigned'
          AND NOT EXISTS (SELECT 1 FROM reviews WHERE assignment_id = review_assignments.id)`,
      ).bind(
        now,
        context.get("authUserId"),
        now,
        assignment.id,
        context.get("authEventId"),
      ).run();
    } catch (error) {
      const review = await findReview(context, assignment.id);
      if (review) {
        return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "A completed reviewer assignment cannot be revoked.");
      }
      console.error("Review assignment revoke failed", { requestId: context.get("requestId"), error });
      throw error;
    }
    const revoked = await findAssignment(context, assignment.id);
    if (revoked?.state !== "revoked") {
      const review = await findReview(context, assignment.id);
      if (review) {
        return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "A completed reviewer assignment cannot be revoked.");
      }
      return errorResponse(context, 409, "ASSIGNMENT_CONFLICT", "The reviewer assignment could not be revoked.");
    }
    if (!revoked.revokedAt) {
      return errorResponse(context, 500, "RESPONSE_CONTRACT_VIOLATION", "The revoked assignment is missing its audit timestamp.");
    }
    return contractData(context, reviewAssignmentRevokeResponseSchema, {
      id: revoked.id,
      status: "revoked",
      revokedAt: revoked.revokedAt,
    });
  });

  routes.get("/events/:eventSlug/cfp/proposals/:proposalId/reviews", async (context) => {
    const eventId = context.get("authEventId");
    const proposal = await context.env.DB.prepare(
      `SELECT id, public_id AS publicId, title, abstract, track, format,
        duration_minutes AS durationMinutes, status
      FROM proposals WHERE id = ? AND event_id = ? LIMIT 1`,
    ).bind(context.req.param("proposalId"), eventId).first<{
      id: string; publicId: string; title: string; abstract: string; track: string; format: QueueRow["format"];
      durationMinutes: number; status: "draft" | "submitted" | "in_review" | "decided";
    }>();
    if (!proposal) {
      return errorResponse(context, 404, "PROPOSAL_NOT_FOUND", "The requested proposal does not exist.");
    }

    const { results: answers } = await context.env.DB.prepare(
      `SELECT answer.field_key AS fieldKey, answer.value
      FROM proposal_answers AS answer
      INNER JOIN cfp_fields AS field
        ON field.event_id = answer.event_id AND field.field_key = answer.field_key
      WHERE answer.event_id = ? AND answer.proposal_id = ? AND field.active = 1
      ORDER BY answer.field_key ASC`,
    ).bind(eventId, proposal.id).all<{ fieldKey: string; value: string }>();

    const { results: participants } = await context.env.DB.prepare(
      `SELECT presenter.id, speaker.name,
        NULLIF(lower(trim(speaker.contact_email)), '') AS email,
        presenter.role
      FROM proposal_presenters AS presenter
      INNER JOIN speakers AS speaker
        ON speaker.id = presenter.speaker_id AND speaker.event_id = presenter.event_id
      WHERE presenter.event_id = ? AND presenter.proposal_id = ?
      ORDER BY presenter.role = 'primary' DESC, lower(speaker.name) ASC, presenter.id ASC`,
    ).bind(eventId, proposal.id).all<{
      id: string;
      name: string;
      email: string | null;
      role: "primary" | "co_presenter";
    }>();

    const { results } = await context.env.DB.prepare(
      `SELECT
        assignment.id AS assignmentId,
        assignment.reviewer_user_id AS reviewerUserId,
        reviewer.display_name AS reviewerName,
        assignment.round,
        assignment.blind,
        assignment.state,
        assignment.due_at AS dueAt,
        assignment.created_at AS createdAt,
        review.id AS reviewId,
        review.originality_score AS originality,
        review.relevance_score AS relevance,
        review.recommendation,
        review.comment,
        review.submitted_at AS submittedAt,
        assignment.review_plan_version_id AS reviewPlanVersionId,
        review.weighted_score_milli AS weightedScoreMilli,
        ${INVITATION_STATUS_SQL} AS invitationStatus,
        (SELECT action.created_at FROM review_assignment_actions AS action
          WHERE action.assignment_id = assignment.id ORDER BY action.sequence DESC LIMIT 1) AS respondedAt,
        (SELECT action.reason FROM review_assignment_actions AS action
          WHERE action.assignment_id = assignment.id ORDER BY action.sequence DESC LIMIT 1) AS responseReason,
        conflict.category AS conflictCategory,
        conflict.note AS conflictNote,
        conflict.created_at AS conflictDeclaredAt
      FROM review_assignments AS assignment
      INNER JOIN users AS reviewer ON reviewer.id = assignment.reviewer_user_id
      LEFT JOIN current_reviews AS review ON review.assignment_id = assignment.id
        AND review.event_id = assignment.event_id
      LEFT JOIN reviewer_conflicts AS conflict ON conflict.assignment_id = assignment.id
      WHERE assignment.event_id = ? AND assignment.proposal_id = ?
      ORDER BY assignment.created_at ASC, assignment.id ASC`,
    ).bind(eventId, proposal.id).all<ProgressRow>();
    const submitted = results.filter((row) => row.reviewId !== null);
    const projectedReviews = await Promise.all(submitted.map(async (row) => {
      const review = await findReview(context, row.assignmentId);
      return {
        ...await scorecardProjection(context, review!),
        assignmentId: row.assignmentId,
        round: row.round,
        reviewer: { userId: row.reviewerUserId, displayName: row.reviewerName },
      };
    }));

    return contractData(context, organizerProposalReviewDetailResponseSchema, {
        proposal: {
          ...proposal,
          participants,
          values: Object.fromEntries(answers.map((answer) => [answer.fieldKey, answer.value])),
        },
        progress: {
          assigned: results.filter((row) => row.state === "assigned"
            && row.invitationStatus !== "declined" && row.invitationStatus !== "recused").length,
          submitted: submitted.length,
          revoked: results.filter((row) => row.state === "revoked").length,
        },
        assignments: results.map((row) => ({
          id: row.assignmentId,
          reviewer: { userId: row.reviewerUserId, displayName: row.reviewerName },
          round: row.round,
          blind: row.blind === 1,
          status: row.state === "revoked" ? "revoked" as const : row.reviewId ? "completed" as const : "pending" as const,
          invitationStatus: row.invitationStatus,
          respondedAt: row.respondedAt,
          responseReason: row.responseReason,
          dueAt: row.dueAt,
          createdAt: row.createdAt,
          conflict: conflictProjection(row),
        })),
        reviews: projectedReviews,
    });
  });

  routes.get("/events/:eventSlug/review/assignments", async (context) => {
    const { results } = await context.env.DB.prepare(
      `SELECT
        assignment.id,
        assignment.round,
        assignment.blind,
        assignment.due_at AS dueAt,
        assignment.created_at AS createdAt,
        proposal.id AS proposalId,
        proposal.public_id AS publicId,
        proposal.title,
        proposal.track,
        proposal.format,
        proposal.duration_minutes AS durationMinutes,
        review.id AS reviewId,
        ${INVITATION_STATUS_SQL} AS invitationStatus,
        conflict.category AS conflictCategory,
        conflict.note AS conflictNote,
        conflict.created_at AS conflictDeclaredAt
      FROM review_assignments AS assignment
      INNER JOIN proposals AS proposal
        ON proposal.id = assignment.proposal_id AND proposal.event_id = assignment.event_id
      LEFT JOIN current_reviews AS review ON review.assignment_id = assignment.id
        AND review.event_id = assignment.event_id
      LEFT JOIN reviewer_conflicts AS conflict ON conflict.assignment_id = assignment.id
      WHERE assignment.event_id = ? AND assignment.reviewer_user_id = ?
        AND assignment.state = 'assigned'
      ORDER BY review.id IS NOT NULL ASC, assignment.due_at IS NULL ASC,
        assignment.due_at ASC, assignment.created_at ASC, assignment.id ASC`,
    ).bind(context.get("authEventId"), context.get("authUserId")).all<QueueRow>();

    return contractData(context, reviewerAssignmentQueueResponseSchema, {
        assignments: results.map((row) => ({
          id: row.id,
          round: row.round,
          blind: row.blind === 1,
          dueAt: row.dueAt,
          status: row.reviewId ? "completed" as const : "pending" as const,
          invitationStatus: row.invitationStatus,
          proposal: {
            publicId: row.publicId,
            title: row.title,
            track: row.track,
            format: row.format,
            durationMinutes: row.durationMinutes,
          },
          conflict: conflictProjection(row),
        })),
    });
  });

  routes.get("/events/:eventSlug/review/assignments/:assignmentId", async (context) => {
    const row = await context.env.DB.prepare(
      `SELECT
        assignment.id,
        assignment.round,
        assignment.blind,
        assignment.due_at AS dueAt,
        assignment.created_at AS createdAt,
        assignment.review_round_id AS reviewRoundId,
        proposal.id AS proposalId,
        proposal.status AS proposalStatus,
        proposal.public_id AS publicId,
        proposal.title,
        proposal.abstract,
        proposal.track,
        proposal.format,
        proposal.duration_minutes AS durationMinutes,
        CASE WHEN assignment.blind = 0 THEN owner.display_name ELSE NULL END AS ownerName,
        review.id AS reviewId,
        review.originality_score AS originality,
        review.relevance_score AS relevance,
        review.recommendation,
        review.comment,
        review.submitted_at AS submittedAt,
        assignment.review_plan_version_id AS reviewPlanVersionId,
        review.weighted_score_milli AS weightedScoreMilli,
        ${INVITATION_STATUS_SQL} AS invitationStatus,
        (SELECT action.created_at FROM review_assignment_actions AS action
          WHERE action.assignment_id = assignment.id ORDER BY action.sequence DESC LIMIT 1) AS respondedAt,
        (SELECT action.reason FROM review_assignment_actions AS action
          WHERE action.assignment_id = assignment.id ORDER BY action.sequence DESC LIMIT 1) AS responseReason,
        conflict.category AS conflictCategory,
        conflict.note AS conflictNote,
        conflict.created_at AS conflictDeclaredAt
      FROM review_assignments AS assignment
      INNER JOIN proposals AS proposal
        ON proposal.id = assignment.proposal_id AND proposal.event_id = assignment.event_id
      LEFT JOIN users AS owner ON owner.id = proposal.owner_user_id
      LEFT JOIN current_reviews AS review ON review.assignment_id = assignment.id
        AND review.event_id = assignment.event_id
      LEFT JOIN reviewer_conflicts AS conflict ON conflict.assignment_id = assignment.id
      WHERE assignment.id = ? AND assignment.event_id = ?
        AND assignment.reviewer_user_id = ? AND assignment.state = 'assigned'
      LIMIT 1`,
    ).bind(
      context.req.param("assignmentId"),
      context.get("authEventId"),
      context.get("authUserId"),
    ).first<DetailRow>();
    if (!row) {
      return errorResponse(context, 404, "ASSIGNMENT_NOT_FOUND", "The requested reviewer assignment does not exist.");
    }

    const { results: answers } = await context.env.DB.prepare(
      `SELECT answer.field_key AS fieldKey, answer.value
      FROM proposal_answers AS answer
      INNER JOIN cfp_fields AS field
        ON field.event_id = answer.event_id AND field.field_key = answer.field_key
      WHERE answer.event_id = ? AND answer.proposal_id = ?
        AND field.active = 1 AND field.section = 'session'
      ORDER BY field.sort_order ASC, field.field_key ASC`,
    ).bind(context.get("authEventId"), row.proposalId).all<AnswerRow>();

    const evaluationPlan = await evaluationPlanByVersion(context.env.DB, context.get("authEventId"), row.reviewPlanVersionId);
    const review = row.reviewId ? await findReview(context, row.id) : null;
    const reviewRound = row.reviewRoundId ? await findRound(context, row.reviewRoundId) : null;
    const correctionAllowed = Boolean(review)
      && row.invitationStatus === "accepted"
      && !row.conflictCategory
      && (row.reviewRoundId
        ? Boolean(reviewRound && roundWindowState(reviewRound, utcNow()) === "open")
        : row.proposalStatus === "submitted" || row.proposalStatus === "in_review");
    const base = {
      id: row.id,
      round: row.round,
      dueAt: row.dueAt,
      status: row.reviewId ? "completed" as const : "pending" as const,
      invitationStatus: row.invitationStatus,
      respondedAt: row.respondedAt,
      responseReason: row.responseReason,
      review: review ? await scorecardProjection(context, review) : null,
      correctionAllowed,
      evaluationPlan,
      conflict: conflictProjection(row),
    };
    const proposal = {
      publicId: row.publicId,
      title: row.title,
      abstract: row.abstract,
      track: row.track,
      format: row.format,
      durationMinutes: row.durationMinutes,
      sessionAnswers: Object.fromEntries(answers.map((answer) => [answer.fieldKey, answer.value])),
    };
    const data = row.blind === 1
      ? { ...base, blind: true as const, proposal }
      : {
          ...base,
          blind: false as const,
          proposal: { ...proposal, ...(row.ownerName ? { authorDisplayName: row.ownerName } : {}) },
        };
    return contractData(context, reviewerAssignmentDetailResponseSchema, data);
  });

  routes.post("/events/:eventSlug/review/assignments/:assignmentId/invitation", async (context) => {
    const input = await parseJson(context, reviewInvitationResponseRequestSchema);
    if (input instanceof Response) return input;
    const assignment = await findAssignment(context, context.req.param("assignmentId"));
    if (!assignment || assignment.reviewerUserId !== context.get("authUserId") || assignment.state !== "assigned") {
      return errorResponse(context, 404, "ASSIGNMENT_NOT_FOUND", "The requested reviewer assignment does not exist.");
    }
    if (assignment.reviewId) {
      return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "A completed assignment cannot change its invitation response.");
    }
    const desired = input.action === "accept" ? "accepted" : "declined";
    const declineReason = input.action === "decline" ? input.reason : null;
    if (assignment.invitationStatus === desired && assignment.respondedAt) {
      if (desired === "declined" && assignment.responseReason !== declineReason) {
        return errorResponse(context, 409, "INVITATION_ALREADY_RESPONDED", "This invitation already has a different response.");
      }
      return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(assignment));
    }
    if (assignment.invitationStatus !== "pending") {
      return errorResponse(context, 409, "INVITATION_ALREADY_RESPONDED", "This invitation response is immutable.");
    }
    const now = new Date().toISOString();
    try {
      await context.env.DB.prepare(
        `INSERT INTO review_assignment_actions (
          id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        context.get("authEventId"),
        assignment.id,
        context.get("authUserId"),
        desired,
        declineReason,
        now,
      ).run();
    } catch (error) {
      const raced = await findAssignment(context, assignment.id);
      if (raced?.invitationStatus === desired && raced.respondedAt
        && (desired !== "declined" || raced.responseReason === declineReason)) {
        return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(raced));
      }
      console.error("Review invitation response failed", { requestId: context.get("requestId"), error });
      return errorResponse(context, 409, "INVITATION_ALREADY_RESPONDED", "This invitation response is immutable.");
    }
    const responded = await findAssignment(context, assignment.id);
    return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(responded!), 201);
  });

  routes.post("/events/:eventSlug/review/assignments/:assignmentId/recuse", async (context) => {
    const input = await parseJson(context, reviewRecusalRequestSchema);
    if (input instanceof Response) return input;
    const assignment = await findAssignment(context, context.req.param("assignmentId"));
    if (!assignment || assignment.reviewerUserId !== context.get("authUserId") || assignment.state !== "assigned") {
      return errorResponse(context, 404, "ASSIGNMENT_NOT_FOUND", "The requested reviewer assignment does not exist.");
    }
    if (assignment.reviewId) {
      return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "A completed assignment cannot be recused.");
    }
    if (assignment.invitationStatus === "recused" && assignment.respondedAt) {
      if (assignment.responseReason !== input.reason) {
        return errorResponse(context, 409, "ASSIGNMENT_ALREADY_RECUSED", "This recusal is immutable.");
      }
      return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(assignment));
    }
    if (assignment.invitationStatus !== "accepted") {
      return errorResponse(context, 409, "ASSIGNMENT_NOT_ACCEPTED", "Accept the invitation before recusing from the assignment.");
    }
    const now = new Date().toISOString();
    const statements = [];
    if (assignment.requiresResponse === 0) {
      statements.push(context.env.DB.prepare(
        `INSERT INTO review_assignment_actions (
          id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
        ) VALUES (?, ?, ?, ?, 1, 'accepted', NULL, ?)`,
      ).bind(crypto.randomUUID(), context.get("authEventId"), assignment.id, context.get("authUserId"), now));
    }
    statements.push(context.env.DB.prepare(
      `INSERT INTO review_assignment_actions (
        id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
      ) VALUES (?, ?, ?, ?, 2, 'recused', ?, ?)`,
    ).bind(crypto.randomUUID(), context.get("authEventId"), assignment.id, context.get("authUserId"), input.reason, now));
    try {
      await context.env.DB.batch(statements);
    } catch (error) {
      const raced = await findAssignment(context, assignment.id);
      if (raced?.invitationStatus === "recused" && raced.respondedAt && raced.responseReason === input.reason) {
        return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(raced));
      }
      console.error("Reviewer recusal failed", { requestId: context.get("requestId"), error });
      return errorResponse(context, 409, "ASSIGNMENT_LIFECYCLE_CONFLICT", "The assignment changed before the recusal was saved.");
    }
    const recused = await findAssignment(context, assignment.id);
    return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(recused!), 201);
  });

  routes.post("/events/:eventSlug/review/assignments/:assignmentId/conflict", async (context) => {
    const input = await parseJson(context, reviewerConflictDeclareSchema);
    if (input instanceof Response) return input;
    const assignment = await findAssignment(context, context.req.param("assignmentId"));
    if (!assignment || assignment.reviewerUserId !== context.get("authUserId") || assignment.state !== "assigned") {
      return errorResponse(context, 404, "ASSIGNMENT_NOT_FOUND", "The requested reviewer assignment does not exist.");
    }
    if (assignment.reviewId) {
      return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "A conflict cannot be declared after submitting a review.");
    }
    const existing = conflictProjection(assignment);
    if (existing) {
      if (existing.category !== input.category || existing.note !== input.note) {
        return errorResponse(context, 409, "CONFLICT_ALREADY_DECLARED", "This conflict declaration is immutable.");
      }
      return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(assignment));
    }
    const now = new Date().toISOString();
    const statements = [];
    if (assignment.invitationStatus === "pending") {
      statements.push(context.env.DB.prepare(
        `INSERT INTO review_assignment_actions (
          id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
        ) VALUES (?, ?, ?, ?, 1, 'declined', ?, ?)`,
      ).bind(crypto.randomUUID(), context.get("authEventId"), assignment.id, context.get("authUserId"), input.note, now));
    } else if (assignment.invitationStatus === "accepted") {
      if (assignment.requiresResponse === 0) {
        statements.push(context.env.DB.prepare(
          `INSERT INTO review_assignment_actions (
            id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
          ) VALUES (?, ?, ?, ?, 1, 'accepted', NULL, ?)`,
        ).bind(crypto.randomUUID(), context.get("authEventId"), assignment.id, context.get("authUserId"), now));
      }
      statements.push(context.env.DB.prepare(
        `INSERT INTO review_assignment_actions (
          id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
        ) VALUES (?, ?, ?, ?, 2, 'recused', ?, ?)`,
      ).bind(crypto.randomUUID(), context.get("authEventId"), assignment.id, context.get("authUserId"), input.note, now));
    }
    statements.push(context.env.DB.prepare(
      `INSERT INTO reviewer_conflicts (
        id, event_id, proposal_id, reviewer_user_id, assignment_id, category, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), context.get("authEventId"), assignment.proposalId,
      context.get("authUserId"), assignment.id, input.category, input.note, now,
    ));
    try {
      await context.env.DB.batch(statements);
    } catch (error) {
      const raced = await findAssignment(context, assignment.id);
      const racedConflict = raced ? conflictProjection(raced) : null;
      if (raced && racedConflict?.category === input.category && racedConflict.note === input.note) {
        return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(raced));
      }
      console.error("Reviewer conflict declaration failed", { requestId: context.get("requestId"), error });
      return errorResponse(context, 409, "CONFLICT_ALREADY_DECLARED", "The assignment changed before the conflict was saved.");
    }
    const conflicted = await findAssignment(context, assignment.id);
    return contractData(context, reviewAssignmentLifecycleResponseSchema, lifecycleProjection(conflicted!), 201);
  });

  routes.post("/events/:eventSlug/review/assignments/:assignmentId/review", async (context) => {
    const input = await parseJson(context, reviewScorecardSubmitSchema);
    if (input instanceof Response) return input;
    const eventId = context.get("authEventId");
    const assignmentId = context.req.param("assignmentId");

    const assignment = await context.env.DB.prepare(
      `SELECT
        assignment.id,
        assignment.review_plan_version_id AS reviewPlanVersionId,
        assignment.review_round_id AS reviewRoundId,
        ${INVITATION_STATUS_SQL} AS invitationStatus,
        proposal.status AS proposalStatus,
        EXISTS (
          SELECT 1 FROM reviewer_conflicts AS conflict
          WHERE conflict.assignment_id = assignment.id
        ) AS hasConflict,
        CASE WHEN proposal.owner_user_id IS assignment.reviewer_user_id OR EXISTS (
          SELECT 1
          FROM proposal_presenters AS presenter
          INNER JOIN speakers AS speaker
            ON speaker.id = presenter.speaker_id AND speaker.event_id = presenter.event_id
          WHERE presenter.event_id = assignment.event_id
            AND presenter.proposal_id = assignment.proposal_id
            AND speaker.user_id IS assignment.reviewer_user_id
        ) THEN 1 ELSE 0 END AS isSelfReview
      FROM review_assignments AS assignment
      INNER JOIN proposals AS proposal
        ON proposal.id = assignment.proposal_id AND proposal.event_id = assignment.event_id
      WHERE assignment.id = ? AND assignment.event_id = ?
        AND assignment.reviewer_user_id = ? AND assignment.state = 'assigned'
      LIMIT 1`,
    ).bind(assignmentId, eventId, context.get("authUserId")).first<{
      id: string; proposalStatus: string; isSelfReview: number; reviewPlanVersionId: string | null;
      reviewRoundId: string | null;
      hasConflict: number;
      invitationStatus: AssignmentRow["invitationStatus"];
    }>();
    if (!assignment) {
      return errorResponse(context, 404, "ASSIGNMENT_NOT_FOUND", "The requested reviewer assignment does not exist.");
    }

    const existing = await findReview(context, assignment.id);
    if (existing && await sameScorecard(context, existing, input)) {
      return contractData(context, submittedReviewSchema, await scorecardProjection(context, existing));
    }
    if (existing && input.expectedRevision === undefined) {
      return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "This assignment already has a submitted scorecard.");
    }
    if (existing && input.expectedRevision !== existing.revisionNumber) {
      return errorResponse(context, 409, "REVIEW_CORRECTION_CONFLICT", "Reload the latest scorecard revision before saving a correction.");
    }
    if (!existing && input.expectedRevision !== undefined) {
      return errorResponse(context, 409, "REVIEW_NOT_SUBMITTED", "This assignment does not have a submitted scorecard to correct.");
    }
    if (!existing && assignment.proposalStatus === "decided" && !assignment.reviewRoundId) {
      return errorResponse(context, 409, "REVIEW_CLOSED", "This assignment is outside any named review round. Use another assignment for this proposal if one exists; otherwise ask the organizer to revoke this one and assign you into an open named round.");
    }
    if (!existing && assignment.proposalStatus !== "submitted" && assignment.proposalStatus !== "in_review" && assignment.proposalStatus !== "decided") {
      return errorResponse(context, 409, "REVIEW_CLOSED", "This proposal is no longer accepting reviews.");
    }
    const now = utcNow();
    if (assignment.reviewRoundId) {
      const reviewRound = await findRound(context, assignment.reviewRoundId);
      if (!reviewRound || roundWindowState(reviewRound, now) !== "open") {
        return errorResponse(context, 409, "REVIEW_ROUND_NOT_OPEN", "Evaluations can only be submitted while the round window is open.");
      }
    } else if (existing && assignment.proposalStatus !== "submitted" && assignment.proposalStatus !== "in_review") {
      return errorResponse(context, 409, "REVIEW_CORRECTION_CLOSED", "This scorecard can no longer be corrected because its unbounded review is closed.");
    }
    if (assignment.isSelfReview === 1) {
      return errorResponse(context, 409, "SELF_REVIEW_NOT_ALLOWED", "A proposal owner cannot review their own proposal.");
    }
    if (assignment.invitationStatus !== "accepted") {
      return errorResponse(context, 409, "ASSIGNMENT_NOT_ACCEPTED", "Accept the invitation before submitting a review.");
    }
    if (assignment.hasConflict === 1) {
      return errorResponse(context, 409, "REVIEW_CONFLICT_DECLARED", "A conflicted assignment cannot submit or correct a scorecard.");
    }

    const plan = await evaluationPlanByVersion(context.env.DB, eventId, assignment.reviewPlanVersionId);
    if (plan && !("criterionScores" in input)) {
      return errorResponse(context, 400, "CRITERION_SCORES_REQUIRED", "Submit one score for every criterion in this assignment's evaluation plan.");
    }
    if (!plan && "criterionScores" in input) {
      return errorResponse(context, 400, "EVALUATION_PLAN_NOT_ASSIGNED", "This assignment uses the legacy scorecard and has no evaluation plan.");
    }
    const weightedMilli = plan && "criterionScores" in input
      ? weightedScoreMilli(plan.criteria, input.criterionScores)
      : null;
    if (plan && weightedMilli === null) {
      return errorResponse(context, 400, "INVALID_CRITERION_SCORES", "Submit exactly one in-range score for every criterion.");
    }
    const legacyScore = weightedMilli === null ? null : Math.max(1, Math.min(5, Math.round(weightedMilli / 1000)));
    const originality = "originality" in input ? input.originality : legacyScore!;
    const relevance = "relevance" in input ? input.relevance : legacyScore!;
    const id = crypto.randomUUID();
    if (existing) {
      try {
        const statements = "criterionScores" in input
          ? input.criterionScores.map(({ criterionId, score }) => context.env.DB.prepare(
            `INSERT INTO review_correction_criterion_score_staging
              (correction_id, event_id, review_id, criterion_id, score)
            VALUES (?, ?, ?, ?, ?)`,
          ).bind(id, eventId, existing.baseReviewId, criterionId, score))
          : [];
        statements.push(context.env.DB.prepare(
          `INSERT INTO review_corrections (
            id, event_id, review_id, revision_number, corrected_by_user_id,
            originality_score, relevance_score, recommendation, comment,
            review_plan_version_id, weighted_score_milli, corrected_at, criterion_scores_staged
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          eventId,
          existing.baseReviewId,
          existing.revisionNumber + 1,
          context.get("authUserId"),
          originality,
          relevance,
          input.recommendation,
          input.comment.trim(),
          assignment.reviewPlanVersionId,
          weightedMilli,
          now,
          "criterionScores" in input ? 1 : 0,
        ));
        await context.env.DB.batch(statements);
      } catch (error) {
        const raced = await findReview(context, assignment.id);
        if (raced && raced.revisionNumber > existing.revisionNumber && await sameScorecard(context, raced, input)) {
          return contractData(context, submittedReviewSchema, await scorecardProjection(context, raced));
        }
        if (TRIGGER_MESSAGES.correctionNotAllowed.test(constraintMessage(error))) {
          return errorResponse(context, 409, "REVIEW_CORRECTION_CLOSED", "This scorecard can no longer be corrected in the current assignment state.");
        }
        if (TRIGGER_MESSAGES.correctionSequenceRace.test(constraintMessage(error)) || (raced && raced.revisionNumber > existing.revisionNumber)) {
          return errorResponse(context, 409, "REVIEW_CORRECTION_CONFLICT", "This scorecard changed before the correction was saved. Reload and review the latest revision.");
        }
        console.error("Review correction failed", { requestId: context.get("requestId"), error });
        throw error;
      }
      const corrected = await findReview(context, assignment.id);
      return contractData(context, submittedReviewSchema, await scorecardProjection(context, corrected!), 201);
    }
    try {
      const statements = [context.env.DB.prepare(
        `INSERT INTO reviews (
          id, event_id, assignment_id, originality_score, relevance_score,
          recommendation, comment, submitted_at, review_plan_version_id, weighted_score_milli
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        eventId,
        assignment.id,
        originality,
        relevance,
        input.recommendation,
        input.comment.trim(),
        now,
        assignment.reviewPlanVersionId,
        weightedMilli,
      )];
      if ("criterionScores" in input) {
        statements.push(...input.criterionScores.map(({ criterionId, score }) => context.env.DB.prepare(
          `INSERT INTO review_criterion_scores (review_id, event_id, criterion_id, score)
          VALUES (?, ?, ?, ?)`,
        ).bind(id, eventId, criterionId, score)));
      }
      await context.env.DB.batch(statements);
    } catch (error) {
      const raced = await findReview(context, assignment.id);
      if (raced && await sameScorecard(context, raced, input)) {
        return contractData(context, submittedReviewSchema, await scorecardProjection(context, raced));
      }
      if (raced) {
        return errorResponse(context, 409, "REVIEW_ALREADY_SUBMITTED", "This scorecard has already been submitted and cannot be edited.");
      }
      if (TRIGGER_MESSAGES.reviewNotAllowed.test(constraintMessage(error))) {
        const currentRound = assignment.reviewRoundId ? await findRound(context, assignment.reviewRoundId) : null;
        if (assignment.reviewRoundId && (!currentRound || roundWindowState(currentRound, now) !== "open")) {
          return errorResponse(context, 409, "REVIEW_ROUND_NOT_OPEN", "Evaluations can only be submitted while the round window is open.");
        }
        return errorResponse(context, 409, "REVIEW_NOT_ALLOWED", "This assignment changed before the scorecard was saved. Reload it and confirm that the invitation, role, conflict, and proposal state still permit review.");
      }
      console.error("Review submission failed", { requestId: context.get("requestId"), error });
      throw error;
    }

    const review = await findReview(context, assignment.id);
    return contractData(context, submittedReviewSchema, await scorecardProjection(context, review!), 201);
  });

  return routes;
}
