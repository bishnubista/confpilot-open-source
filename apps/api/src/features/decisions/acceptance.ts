import type { Database, DatabaseStatement } from "../../runtime/database";

export const DEFAULT_TASKS = [
  ["confirm", "Confirm participation"],
  ["profile", "Complete bio and profile"],
  ["release", "Sign speaker release form"],
  ["headshot", "Upload final headshot"],
] as const;

export interface AcceptanceSource {
  decisionId: string;
  eventId: string;
  proposalId: string;
  slug: string;
  title: string;
  abstract: string;
  track: string;
  format: string;
  durationMinutes: number;
  eventName: string;
  presenterCount: number;
  primaryPresenterCount: number;
  existingAcceptanceId: string | null;
  existingProgramSessionId: string | null;
}

export interface MaterializeAcceptanceInput {
  eventId: string;
  decisionId: string;
  acceptedByUserId: string;
  acceptedAt: string;
}

export interface MaterializedAcceptance {
  id: string;
  eventId: string;
  proposalId: string;
  decisionId: string;
  programSessionId: string;
  idempotencyKey: string;
  acceptedAt: string;
}

export class AcceptanceNotAllowedError extends Error {
  constructor() {
    super("The decision cannot be accepted in this event by this actor.");
    this.name = "AcceptanceNotAllowedError";
  }
}

export class AcceptanceConflictError extends Error {
  constructor() {
    super("The proposal is already associated with another acceptance decision.");
    this.name = "AcceptanceConflictError";
  }
}

export class AcceptancePersistenceError extends Error {
  constructor() {
    super("Acceptance materialization completed without a persisted acceptance row.");
    this.name = "AcceptancePersistenceError";
  }
}

export function acceptanceStatements(
  database: Database,
  source: AcceptanceSource,
  input: Pick<MaterializeAcceptanceInput, "acceptedByUserId" | "acceptedAt">,
) {
  if (source.presenterCount < 1 || source.primaryPresenterCount !== 1) {
    throw new AcceptanceNotAllowedError();
  }

  const programSessionId =
    source.existingProgramSessionId ?? `session:${source.eventId}:${source.proposalId}`;
  const acceptanceId =
    source.existingAcceptanceId ?? `acceptance:${source.eventId}:${source.proposalId}`;
  const idempotencyKey = `decision:${source.decisionId}`;

  const statements: DatabaseStatement[] = [
    database
      .prepare(
        `INSERT INTO program_sessions (
          id, event_id, source_proposal_id, slug, title, abstract, track, format,
          duration_minutes, publication_status, deliverables_status, approval_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'missing', 'pending', ?, ?)
        ON CONFLICT (event_id, source_proposal_id) DO NOTHING`,
      )
      .bind(
        programSessionId,
        source.eventId,
        source.proposalId,
        source.slug,
        source.title,
        source.abstract,
        source.track,
        source.format,
        source.durationMinutes,
        input.acceptedAt,
        input.acceptedAt,
      ),
    database
      .prepare(
        `INSERT INTO acceptances (
          id, event_id, proposal_id, decision_id, program_session_id,
          accepted_by_user_id, idempotency_key, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (event_id, proposal_id) DO NOTHING`,
      )
      .bind(
        acceptanceId,
        source.eventId,
        source.proposalId,
        source.decisionId,
        programSessionId,
        input.acceptedByUserId,
        idempotencyKey,
        input.acceptedAt,
      ),
    database
      .prepare(
        `INSERT INTO session_presenters (id, event_id, program_session_id, speaker_id, role)
        SELECT 'session-presenter:' || presenter.id, presenter.event_id, ?, presenter.speaker_id, presenter.role
        FROM proposal_presenters presenter
        WHERE presenter.event_id = ? AND presenter.proposal_id = ?
        ON CONFLICT (event_id, program_session_id, speaker_id) DO NOTHING`,
      )
      .bind(programSessionId, source.eventId, source.proposalId),
  ];

  for (const [taskKey, label] of DEFAULT_TASKS) {
    statements.push(
      database
        .prepare(
          `INSERT INTO speaker_tasks (
            id, event_id, acceptance_id, program_session_id, speaker_id,
            task_key, label, state, created_at, completed_at, revision, updated_at,
            created_by_user_id
          )
          SELECT
            'task:' || presenter.id || ':' || ?, presenter.event_id, ?,
            presenter.program_session_id, presenter.speaker_id, ?, ?, 'open', ?, NULL, 1, ?, ?
          FROM session_presenters presenter
          WHERE presenter.event_id = ? AND presenter.program_session_id = ?
          ON CONFLICT (event_id, program_session_id, speaker_id, task_key) DO NOTHING`,
        )
        .bind(
          taskKey,
          acceptanceId,
          taskKey,
          label,
          input.acceptedAt,
          input.acceptedAt,
          input.acceptedByUserId,
          source.eventId,
          programSessionId,
        ),
    );
  }

  return statements;
}

export async function materializeAcceptance(
  database: Database,
  input: MaterializeAcceptanceInput,
): Promise<MaterializedAcceptance> {
  const source = await database
    .prepare(
      `SELECT
        decision.id AS decisionId,
        decision.event_id AS eventId,
        proposal.id AS proposalId,
        proposal.slug AS slug,
        proposal.title AS title,
        proposal.abstract AS abstract,
        proposal.track AS track,
        proposal.format AS format,
        proposal.duration_minutes AS durationMinutes,
        event.name AS eventName,
        (SELECT COUNT(*) FROM proposal_presenters presenter
          WHERE presenter.event_id = proposal.event_id
            AND presenter.proposal_id = proposal.id) AS presenterCount,
        (SELECT COUNT(*) FROM proposal_presenters presenter
          WHERE presenter.event_id = proposal.event_id
            AND presenter.proposal_id = proposal.id
            AND presenter.role = 'primary') AS primaryPresenterCount,
        acceptance.id AS existingAcceptanceId,
        program_session.id AS existingProgramSessionId
      FROM decisions decision
      INNER JOIN proposals proposal
        ON proposal.id = decision.proposal_id
        AND proposal.event_id = decision.event_id
      INNER JOIN events event ON event.id = decision.event_id
      INNER JOIN event_memberships membership
        ON membership.event_id = decision.event_id
        AND membership.user_id = ?
        AND membership.role = 'organizer'
      LEFT JOIN program_sessions program_session
        ON program_session.event_id = proposal.event_id
        AND program_session.source_proposal_id = proposal.id
      LEFT JOIN acceptances acceptance
        ON acceptance.event_id = proposal.event_id
        AND acceptance.proposal_id = proposal.id
      WHERE decision.id = ?
        AND decision.event_id = ?
        AND decision.decision = 'accept'`,
    )
    .bind(input.acceptedByUserId, input.decisionId, input.eventId)
    .first<AcceptanceSource>();

  if (!source) {
    throw new AcceptanceNotAllowedError();
  }

  await database.batch(acceptanceStatements(database, source, input));

  const acceptance = await database
    .prepare(
      `SELECT
        id,
        event_id AS eventId,
        proposal_id AS proposalId,
        decision_id AS decisionId,
        program_session_id AS programSessionId,
        idempotency_key AS idempotencyKey,
        accepted_at AS acceptedAt
      FROM acceptances
      WHERE event_id = ? AND proposal_id = ?`,
    )
    .bind(source.eventId, source.proposalId)
    .first<MaterializedAcceptance>();

  if (!acceptance) {
    throw new AcceptancePersistenceError();
  }

  if (acceptance.decisionId !== source.decisionId) {
    throw new AcceptanceConflictError();
  }

  return acceptance;
}
