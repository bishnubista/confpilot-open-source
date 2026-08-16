import type { Database } from "../../runtime/database";

export interface ProposalReviewResultRow {
  proposalId: string;
  publicId: string;
  title: string;
  track: string;
  format: "keynote" | "talk" | "lightning" | "workshop" | "panel";
  proposalStatus: "draft" | "submitted" | "in_review" | "decided";
  assignedCount: number;
  completedCount: number;
  averageScore: number | null;
  acceptCount: number;
  discussCount: number;
  rejectCount: number;
}

export async function listProposalReviewResults(database: Database, eventId: string) {
  const { results } = await database.prepare(
    `SELECT
      proposal.id AS proposalId,
      proposal.public_id AS publicId,
      proposal.title,
      proposal.track,
      proposal.format,
      proposal.status AS proposalStatus,
      SUM(CASE WHEN assignment.state = 'assigned' AND NOT EXISTS (
        SELECT 1 FROM review_assignment_actions AS action
        WHERE action.assignment_id = assignment.id AND action.action IN ('declined', 'recused')
      ) THEN 1 ELSE 0 END) AS assignedCount,
      COUNT(review.id) AS completedCount,
      AVG(CASE WHEN review.id IS NOT NULL
        THEN COALESCE(review.weighted_score_milli / 1000.0,
          (review.originality_score + review.relevance_score) / 2.0) END) AS averageScore,
      SUM(CASE WHEN review.recommendation = 'accept' THEN 1 ELSE 0 END) AS acceptCount,
      SUM(CASE WHEN review.recommendation = 'discuss' THEN 1 ELSE 0 END) AS discussCount,
      SUM(CASE WHEN review.recommendation = 'reject' THEN 1 ELSE 0 END) AS rejectCount
    FROM proposals AS proposal
    LEFT JOIN review_assignments AS assignment
      ON assignment.event_id = proposal.event_id AND assignment.proposal_id = proposal.id
    LEFT JOIN current_reviews AS review ON review.assignment_id = assignment.id
      AND review.event_id = assignment.event_id
    WHERE proposal.event_id = ?
      AND (proposal.status IN ('submitted', 'in_review') OR assignment.id IS NOT NULL)
    GROUP BY proposal.id, proposal.public_id, proposal.title, proposal.track, proposal.format, proposal.status
    ORDER BY proposal.created_at ASC, proposal.id ASC`,
  ).bind(eventId).all<ProposalReviewResultRow>();
  return results;
}

const CSV_COLUMNS = [
  "public_id",
  "title",
  "track",
  "format",
  "proposal_status",
  "assigned_reviews",
  "completed_reviews",
  "average_score",
  "accept_count",
  "discuss_count",
  "reject_count",
] as const;

function csvCell(value: string | number | null) {
  let text = value === null ? "" : String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

interface CsvCriterionRow { id: string; key: string; versionNumber: number }
interface CsvCriterionScoreRow { proposalId: string; criterionId: string; averageScore: number }

export async function proposalReviewResultsCsv(
  database: Database,
  eventId: string,
  rows: ProposalReviewResultRow[],
) {
  const { results: criteria } = await database.prepare(
    `SELECT criterion.id, criterion.criterion_key AS key, version.version_number AS versionNumber
    FROM review_plan_versions AS version
    INNER JOIN review_criteria AS criterion ON criterion.plan_version_id = version.id
      AND criterion.event_id = version.event_id
    WHERE version.event_id = ? ORDER BY version.version_number, criterion.sort_order, criterion.id`,
  ).bind(eventId).all<CsvCriterionRow>();
  const { results: criterionScores } = await database.prepare(
    `SELECT assignment.proposal_id AS proposalId, score.criterion_id AS criterionId,
      AVG(score.score) AS averageScore
    FROM current_review_criterion_scores AS score
    INNER JOIN current_reviews AS review ON review.id = score.review_id AND review.event_id = score.event_id
    INNER JOIN review_assignments AS assignment ON assignment.id = review.assignment_id
      AND assignment.event_id = review.event_id
    WHERE review.event_id = ?
    GROUP BY assignment.proposal_id, score.criterion_id`,
  ).bind(eventId).all<CsvCriterionScoreRow>();
  const scoreByProposalCriterion = new Map(criterionScores.map((score) => [
    `${score.proposalId}:${score.criterionId}`,
    score.averageScore,
  ]));
  const columns = [
    ...CSV_COLUMNS,
    ...criteria.map((criterion) => `criterion_v${criterion.versionNumber}_${criterion.key}_average`),
  ];
  const records = rows.map((row) => [
    row.publicId,
    row.title,
    row.track,
    row.format,
    row.proposalStatus,
    row.assignedCount,
    row.completedCount,
    row.averageScore,
    row.acceptCount,
    row.discussCount,
    row.rejectCount,
    ...criteria.map((criterion) => scoreByProposalCriterion.get(`${row.proposalId}:${criterion.id}`) ?? null),
  ]);
  return [columns, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
