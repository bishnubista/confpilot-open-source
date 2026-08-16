import type { EvaluationPlanVersion, EvaluationPlanWrite } from "@confpilot/contracts";
import type { Database, DatabaseStatement } from "../../runtime/database";

interface PlanRow {
  planId: string;
  versionId: string;
  versionNumber: number;
  name: string;
  createdAt: string;
  builtinLabelsJson: string | null;
}

interface CriterionRow {
  id: string;
  key: string;
  label: string;
  description: string;
  weightBasisPoints: number;
  minimumScore: number;
  maximumScore: number;
  sortOrder: number;
}

type BuiltinLabels = NonNullable<EvaluationPlanVersion["builtinLabels"]>;

const DEFAULT_BUILTIN_LABELS: BuiltinLabels = {
  recommendationAccept: "Accept",
  recommendationDiscuss: "Discuss",
  recommendationReject: "Reject",
  commentsLabel: "Comments",
};

/** NULL storage means "defaults"; an explicit default set is normalized to NULL so replays stay idempotent. */
function normalizeBuiltinLabels(labels: BuiltinLabels | null | undefined): BuiltinLabels | null {
  if (!labels) return null;
  const isDefault = labels.recommendationAccept === DEFAULT_BUILTIN_LABELS.recommendationAccept
    && labels.recommendationDiscuss === DEFAULT_BUILTIN_LABELS.recommendationDiscuss
    && labels.recommendationReject === DEFAULT_BUILTIN_LABELS.recommendationReject
    && labels.commentsLabel === DEFAULT_BUILTIN_LABELS.commentsLabel;
  return isDefault ? null : labels;
}

export class EvaluationPlanConflictError extends Error {}

function parseBuiltinLabels(json: string | null): BuiltinLabels | null {
  if (!json) return null;
  // The insert trigger validates shape, but rows can predate it or arrive via
  // backfill; a malformed value must degrade to defaults, not a 500.
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const labels = value as Record<string, unknown>;
  const fields = [
    labels.recommendationAccept,
    labels.recommendationDiscuss,
    labels.recommendationReject,
    labels.commentsLabel,
  ];
  if (!fields.every((field) => typeof field === "string" && field.trim().length >= 1 && field.trim().length <= 40)) {
    return null;
  }
  return {
    recommendationAccept: (labels.recommendationAccept as string).trim(),
    recommendationDiscuss: (labels.recommendationDiscuss as string).trim(),
    recommendationReject: (labels.recommendationReject as string).trim(),
    commentsLabel: (labels.commentsLabel as string).trim(),
  };
}

function sameBuiltinLabels(current: BuiltinLabels | null, expected: BuiltinLabels | null | undefined) {
  const normalizedCurrent = normalizeBuiltinLabels(current);
  const normalized = normalizeBuiltinLabels(expected);
  if (normalizedCurrent === null || normalized === null) return normalizedCurrent === normalized;
  return normalizedCurrent.recommendationAccept === normalized.recommendationAccept
    && normalizedCurrent.recommendationDiscuss === normalized.recommendationDiscuss
    && normalizedCurrent.recommendationReject === normalized.recommendationReject
    && normalizedCurrent.commentsLabel === normalized.commentsLabel;
}

function samePlan(plan: EvaluationPlanVersion | null, input: EvaluationPlanWrite) {
  return plan !== null && plan.name === input.name && plan.criteria.length === input.criteria.length
    && sameBuiltinLabels(plan.builtinLabels, input.builtinLabels)
    && plan.criteria.every((criterion, index) => {
      const expected = input.criteria[index];
      return expected !== undefined
        && criterion.key === expected.key
        && criterion.label === expected.label
        && criterion.description === expected.description
        && criterion.weightBasisPoints === expected.weightBasisPoints
        && criterion.minimumScore === expected.minimumScore
        && criterion.maximumScore === expected.maximumScore;
    });
}

async function planCriteria(database: Database, eventId: string, versionId: string) {
  const { results } = await database.prepare(
    `SELECT id, criterion_key AS key, label, description,
      weight_basis_points AS weightBasisPoints, minimum_score AS minimumScore,
      maximum_score AS maximumScore, sort_order AS sortOrder
    FROM review_criteria WHERE event_id = ? AND plan_version_id = ?
    ORDER BY sort_order, id`,
  ).bind(eventId, versionId).all<CriterionRow>();
  return results;
}

function planResponse(plan: PlanRow, criteria: CriterionRow[]): EvaluationPlanVersion {
  const { builtinLabelsJson, ...base } = plan;
  return { ...base, criteria, builtinLabels: parseBuiltinLabels(builtinLabelsJson) };
}

export async function activeEvaluationPlan(
  database: Database,
  eventId: string,
  reviewRoundId: string | null = null,
): Promise<EvaluationPlanVersion | null> {
  const plan = await database.prepare(
    `SELECT plan.id AS planId, version.id AS versionId,
      version.version_number AS versionNumber, version.name, version.created_at AS createdAt,
      version.builtin_labels_json AS builtinLabelsJson
    FROM review_plans AS plan
    INNER JOIN review_plan_versions AS version ON version.id = plan.active_version_id
    WHERE plan.event_id = ? AND plan.review_round_id IS ? LIMIT 1`,
  ).bind(eventId, reviewRoundId).first<PlanRow>();
  if (!plan) return null;
  return planResponse(plan, await planCriteria(database, eventId, plan.versionId));
}

export async function evaluationPlanByVersion(
  database: Database,
  eventId: string,
  versionId: string | null,
) {
  if (!versionId) return null;
  const plan = await database.prepare(
    `SELECT plan.id AS planId, version.id AS versionId,
      version.version_number AS versionNumber, version.name, version.created_at AS createdAt,
      version.builtin_labels_json AS builtinLabelsJson
    FROM review_plan_versions AS version
    INNER JOIN review_plans AS plan ON plan.id = version.plan_id AND plan.event_id = version.event_id
    WHERE version.event_id = ? AND version.id = ? LIMIT 1`,
  ).bind(eventId, versionId).first<PlanRow>();
  if (!plan) return null;
  return planResponse(plan, await planCriteria(database, eventId, plan.versionId));
}

export async function createEvaluationPlanVersion(
  database: Database,
  eventId: string,
  organizerUserId: string,
  input: EvaluationPlanWrite,
  reviewRoundId: string | null = null,
) {
  const active = await activeEvaluationPlan(database, eventId, reviewRoundId);
  if (samePlan(active, input)) return active!;
  const existing = await database.prepare(
    "SELECT id FROM review_plans WHERE event_id = ? AND review_round_id IS ? LIMIT 1",
  ).bind(eventId, reviewRoundId).first<{ id: string }>();
  const planId = existing?.id ?? crypto.randomUUID();
  const versionNumber = await database.prepare(
    "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM review_plan_versions WHERE plan_id = ?",
  ).bind(planId).first<number>("next") ?? 1;
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const normalizedLabels = normalizeBuiltinLabels(input.builtinLabels);
  const builtinLabelsJson = normalizedLabels ? JSON.stringify({
    recommendationAccept: normalizedLabels.recommendationAccept,
    recommendationDiscuss: normalizedLabels.recommendationDiscuss,
    recommendationReject: normalizedLabels.recommendationReject,
    commentsLabel: normalizedLabels.commentsLabel,
  }) : null;
  const statements: DatabaseStatement[] = [];
  if (!existing) {
    statements.push(database.prepare(
      `INSERT INTO review_plans (id, event_id, name, created_by_user_id, created_at, review_round_id)
      VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(planId, eventId, input.name, organizerUserId, now, reviewRoundId));
  }
  statements.push(database.prepare(
    `INSERT INTO review_plan_versions
      (id, event_id, plan_id, version_number, name, created_by_user_id, created_at, builtin_labels_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(versionId, eventId, planId, versionNumber, input.name, organizerUserId, now, builtinLabelsJson));
  input.criteria.forEach((criterion, sortOrder) => statements.push(database.prepare(
    `INSERT INTO review_criteria
      (id, event_id, plan_version_id, criterion_key, label, description,
       weight_basis_points, minimum_score, maximum_score, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), eventId, versionId, criterion.key, criterion.label, criterion.description,
    criterion.weightBasisPoints, criterion.minimumScore, criterion.maximumScore, sortOrder,
  )));
  statements.push(database.prepare(
    `UPDATE review_plans SET active_version_id = ?, activated_by_user_id = ?
    WHERE id = ? AND event_id = ?`,
  ).bind(versionId, organizerUserId, planId, eventId));
  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await activeEvaluationPlan(database, eventId, reviewRoundId);
    if (samePlan(raced, input)) return raced!;
    throw new EvaluationPlanConflictError("The active evaluation plan changed while this version was being created.", { cause: error });
  }
  return (await evaluationPlanByVersion(database, eventId, versionId))!;
}

export function weightedScoreMilli(
  criteria: Array<{ id: string; weightBasisPoints: number; minimumScore: number; maximumScore: number }>,
  scores: Array<{ criterionId: string; score: number }>,
) {
  if (criteria.reduce((total, criterion) => total + criterion.weightBasisPoints, 0) !== 10_000
    || scores.length !== criteria.length
    || new Set(scores.map(({ criterionId }) => criterionId)).size !== scores.length) {
    return null;
  }
  const scoreByCriterion = new Map(scores.map(({ criterionId, score }) => [criterionId, score]));
  let weightedSum = 0;
  for (const criterion of criteria) {
    if (criterion.maximumScore <= criterion.minimumScore) return null;
    const score = scoreByCriterion.get(criterion.id);
    if (score === undefined || score < criterion.minimumScore || score > criterion.maximumScore) return null;
    const normalizedMilli = Math.round(
      1_000 + ((score - criterion.minimumScore) * 4_000) / (criterion.maximumScore - criterion.minimumScore),
    );
    weightedSum += normalizedMilli * criterion.weightBasisPoints;
  }
  return Math.round(weightedSum / 10_000);
}
