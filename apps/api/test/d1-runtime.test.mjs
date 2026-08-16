import { beforeEach, describe, expect, it } from "vitest";

import { materializeAcceptance } from "../src/features/decisions/acceptance.ts";
import { shareD1Database } from "./support/miniflare.mjs";
import {
  applyD1Sql,
  applySql,
  migrationScripts,
  seedScript,
} from "./support/migration-conformance.mjs";

// One workerd process for the file rather than three.
const openSharedD1 = shareD1Database();

function addAcceptedDecision(database, suffix) {
  return applySql(database, `
    INSERT INTO proposals (
      id, event_id, public_id, slug, title, abstract, track, format,
      duration_minutes, status, submitted_at, created_at, updated_at
    ) VALUES (
      'prop-d-${suffix}', 'evt-devflow', 'ABS-${suffix}', 'proposal-${suffix}',
      'Proposal ${suffix}', 'D1 rollback fixture.', 'AI Engineering', 'talk',
      30, 'decided', '2027-01-20T18:00:00Z', '2027-01-20T18:00:00Z',
      '2027-02-20T18:00:00Z'
    );
    INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
    VALUES ('pp-d-${suffix}', 'evt-devflow', 'prop-d-${suffix}', 'spk-d-priya', 'primary');
    INSERT INTO decisions (
      id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
    ) VALUES (
      'dec-d-${suffix}', 'evt-devflow', 'prop-d-${suffix}', 'accept', 'Strong evidence.',
      'usr-devflow-organizer', '2027-02-20T18:00:00Z'
    );
  `);
}

async function count(database, table, column, value) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(value).first("count");
}

describe("D1 acceptance transaction", () => {
  let database;

  /**
   * A migrated database per test, because these tests genuinely conflict: the
   * rollback test asserts that nothing exists for `prop-d-second`, which the
   * first test materializes. What is shared is the workerd process, and the
   * migrations go in as one batch per file rather than 485 separate round-trips
   * — the same statements in the same order, about a third of the hook time.
   */
  beforeEach(async () => {
    database = await openSharedD1();
    for (const migration of migrationScripts) await applyD1Sql(database, migration);
    await applyD1Sql(database, seedScript);
  }, 30_000);

  it("derives independent acceptance keys without client input", async () => {
    await addAcceptedDecision(database, "first");
    await addAcceptedDecision(database, "second");

    const sharedInput = {
      eventId: "evt-devflow",
      acceptedByUserId: "usr-devflow-organizer",
      acceptedAt: "2027-02-20T18:01:00Z",
    };
    const first = await materializeAcceptance(database, { ...sharedInput, decisionId: "dec-d-first" });
    const second = await materializeAcceptance(database, {
      ...sharedInput,
      decisionId: "dec-d-second",
    });
    expect(first.idempotencyKey).toBe("decision:dec-d-first");
    expect(second.idempotencyKey).toBe("decision:dec-d-second");

    expect(await database.prepare("PRAGMA foreign_keys").first("foreign_keys")).toBe(1);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const secondSessionId = second.programSessionId;
    expect(await count(database, "program_sessions", "source_proposal_id", "prop-d-second")).toBe(1);
    expect(await count(database, "acceptances", "proposal_id", "prop-d-second")).toBe(1);
    expect(await count(database, "session_presenters", "program_session_id", secondSessionId)).toBe(1);
    expect(await count(database, "speaker_tasks", "program_session_id", secondSessionId)).toBe(4);
    expect(await count(database, "notification_outbox", "decision_id", "dec-d-second")).toBe(0);
  });

  it("rolls back earlier D1 batch writes when a later statement fails", async () => {
    await addAcceptedDecision(database, "second");
    await addAcceptedDecision(database, "blocker");
    await applySql(database, `
      INSERT INTO program_sessions (
        id, event_id, source_proposal_id, slug, title, abstract, track, format,
        duration_minutes, publication_status, deliverables_status, approval_status,
        created_at, updated_at
      ) VALUES (
        'session:evt-devflow:prop-d-blocker', 'evt-devflow', 'prop-d-blocker',
        'proposal-blocker', 'Proposal blocker', 'D1 rollback blocker.',
        'AI Engineering', 'talk', 30, 'private', 'missing', 'pending',
        '2027-02-20T18:00:00Z', '2027-02-20T18:00:00Z'
      );
      INSERT INTO acceptances (
        id, event_id, proposal_id, decision_id, program_session_id,
        accepted_by_user_id, idempotency_key, accepted_at
      ) VALUES (
        'acceptance:evt-devflow:prop-d-second', 'evt-devflow', 'prop-d-blocker',
        'dec-d-blocker', 'session:evt-devflow:prop-d-blocker',
        'usr-devflow-organizer', 'blocker-key', '2027-02-20T18:01:00Z'
      );
    `);

    await expect(materializeAcceptance(database, {
      eventId: "evt-devflow",
      decisionId: "dec-d-second",
      acceptedByUserId: "usr-devflow-organizer",
      acceptedAt: "2027-02-20T18:02:00Z",
    })).rejects.toThrow();

    const secondSessionId = "session:evt-devflow:prop-d-second";
    expect(await count(database, "program_sessions", "source_proposal_id", "prop-d-second")).toBe(0);
    expect(await count(database, "acceptances", "proposal_id", "prop-d-second")).toBe(0);
    expect(await count(database, "session_presenters", "program_session_id", secondSessionId)).toBe(0);
    expect(await count(database, "speaker_tasks", "program_session_id", secondSessionId)).toBe(0);
    expect(await count(database, "notification_outbox", "decision_id", "dec-d-second")).toBe(0);
    expect(await count(database, "acceptances", "proposal_id", "prop-d-blocker")).toBe(1);
  });

  it("materializes exactly one acceptance under concurrent retries", async () => {
    await addAcceptedDecision(database, "concurrent");
    const input = {
      eventId: "evt-devflow",
      decisionId: "dec-d-concurrent",
      acceptedByUserId: "usr-devflow-organizer",
      acceptedAt: "2027-02-20T18:01:00Z",
    };

    const [first, second] = await Promise.all([
      materializeAcceptance(database, input),
      materializeAcceptance(database, input),
    ]);

    expect(second).toEqual(first);
    expect(await count(database, "program_sessions", "source_proposal_id", "prop-d-concurrent")).toBe(1);
    expect(await count(database, "acceptances", "proposal_id", "prop-d-concurrent")).toBe(1);
    expect(await count(database, "session_presenters", "program_session_id", first.programSessionId)).toBe(1);
    expect(await count(database, "speaker_tasks", "program_session_id", first.programSessionId)).toBe(4);
    expect(await count(database, "notification_outbox", "acceptance_id", first.id)).toBe(0);
  });
});
