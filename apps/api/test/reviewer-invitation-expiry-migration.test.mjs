import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const names = readdirSync(migrationsUrl)
  .filter((value) => /^\d{4}_[a-z0-9_]+\.sql$/.test(value))
  .sort();

function replaceExactly(source, search, replacement, expectedCount) {
  const count = typeof search === "string"
    ? source.split(search).length - 1
    : [...source.matchAll(new RegExp(search.source, `${search.flags.replace("g", "")}g`))].length;
  if (count !== expectedCount) {
    throw new Error(`Expected legacy migration rewrite to match ${expectedCount} time(s), found ${count}.`);
  }
  return typeof search === "string"
    ? source.replaceAll(search, replacement)
    : source.replace(search, replacement);
}

function legacyReviewerInvitationMigration() {
  let migration = readFileSync(new URL("0016_reviewer_invitations.sql", migrationsUrl), "utf8");
  migration = replaceExactly(
    migration,
    "('pending', 'accepted', 'revoked', 'expired')",
    "('pending', 'accepted', 'revoked')",
    1,
  );
  migration = replaceExactly(migration, "  expired_at TEXT,\n", "", 1);
  migration = replaceExactly(migration, " AND expired_at IS NULL", "", 3);
  return replaceExactly(migration, /\n    OR \(state = 'expired'[^\n]+\)/, "", 1);
}

function insertMessage(database, { id, email }) {
  database.prepare(`INSERT INTO message_outbox (
    id, event_id, actor_user_id, dedupe_key, intent, recipient_email, recipient_name,
    template_key, template_revision, subject, text_body, content_sha256, state,
    attempt_count, next_attempt_at, created_at, updated_at, expires_at
  ) VALUES (?, 'evt-devflow', 'usr-devflow-organizer', ?, 'reviewer_invitation', ?,
    'Upgrade Reviewer', 'reviewer.account-invitation', 1, 'Upgrade invitation',
    'Upgrade invitation body.', ?, 'queued', 0, '2026-08-13T12:00:00Z',
    '2026-08-13T12:00:00Z', '2026-08-13T12:00:00Z', '2026-08-14T12:00:00Z')`)
    .run(id, `dedupe-${id}`, email, "0".repeat(64));
}

function invitationSchema(database) {
  return database.prepare(`SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE tbl_name IN ('reviewer_invitations', 'reviewer_invitation_acceptances')
    ORDER BY type, name`).all();
}

describe("reviewer invitation expiry compatibility migration", () => {
  it("upgrades the previously applied table shape and preserves invitations and receipts", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    try {
      for (const name of names) {
        if (name === "0023_reviewer_invitation_expiry_compatibility.sql") break;
        database.exec(name === "0016_reviewer_invitations.sql"
          ? legacyReviewerInvitationMigration()
          : readFileSync(new URL(name, migrationsUrl), "utf8"));
      }
      expect(database.prepare("PRAGMA table_info(reviewer_invitations)").all()
        .some(({ name }) => name === "expired_at")).toBe(false);
      expect(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reviewer_invitations'").get().sql)
        .not.toContain("'expired'");
      database.exec(readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8"));
      database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES ('usr-upgrade-reviewer', 'accepted-upgrade@example.test', 'Accepted Upgrade', '2026-08-13T12:00:00Z')").run();

      insertMessage(database, { id: "msg-upgrade-pending", email: "pending-upgrade@example.test" });
      insertMessage(database, { id: "msg-upgrade-accepted", email: "accepted-upgrade@example.test" });
      insertMessage(database, { id: "msg-upgrade-revoked", email: "revoked-upgrade@example.test" });
      database.prepare(`INSERT INTO reviewer_invitations (
        id, event_id, email, display_name, token_hash, idempotency_key, state, expires_at,
        invited_by_user_id, accepted_by_user_id, revoked_by_user_id, outbox_message_id,
        created_at, updated_at, accepted_at, revoked_at
      ) VALUES
        ('invite-upgrade-pending', 'evt-devflow', 'pending-upgrade@example.test', 'Pending Upgrade', ?,
          'upgrade-pending', 'pending', '2026-08-14T12:00:00Z', 'usr-devflow-organizer', NULL, NULL,
          'msg-upgrade-pending', '2026-08-13T12:00:00Z', '2026-08-13T12:00:00Z', NULL, NULL),
        ('invite-upgrade-accepted', 'evt-devflow', 'accepted-upgrade@example.test', 'Accepted Upgrade', ?,
          'upgrade-accepted', 'accepted', '2026-08-14T12:00:00Z', 'usr-devflow-organizer',
          'usr-upgrade-reviewer', NULL, 'msg-upgrade-accepted', '2026-08-13T12:00:00Z',
          '2026-08-13T13:00:00Z', '2026-08-13T13:00:00Z', NULL),
        ('invite-upgrade-revoked', 'evt-devflow', 'revoked-upgrade@example.test', 'Revoked Upgrade', ?,
          'upgrade-revoked', 'revoked', '2026-08-14T12:00:00Z', 'usr-devflow-organizer', NULL,
          'usr-devflow-organizer', 'msg-upgrade-revoked', '2026-08-13T12:00:00Z',
          '2026-08-13T14:00:00Z', NULL, '2026-08-13T14:00:00Z')`)
        .run("a".repeat(64), "b".repeat(64), "c".repeat(64));
      database.prepare(`INSERT INTO reviewer_invitation_acceptances
        (invitation_id, event_id, user_id, accepted_at)
        VALUES ('invite-upgrade-accepted', 'evt-devflow', 'usr-upgrade-reviewer', '2026-08-13T13:00:00Z')`).run();

      database.exec(readFileSync(new URL("0023_reviewer_invitation_expiry_compatibility.sql", migrationsUrl), "utf8"));
      database.exec(readFileSync(new URL("0024_integrated_review_hardening.sql", migrationsUrl), "utf8"));

      expect(database.prepare("PRAGMA table_info(reviewer_invitations)").all()
        .some(({ name }) => name === "expired_at")).toBe(true);
      expect(database.prepare("SELECT id, state, expired_at AS expiredAt FROM reviewer_invitations ORDER BY id").all())
        .toEqual([
          { id: "invite-upgrade-accepted", state: "accepted", expiredAt: null },
          { id: "invite-upgrade-pending", state: "pending", expiredAt: null },
          { id: "invite-upgrade-revoked", state: "revoked", expiredAt: null },
        ]);
      expect(database.prepare("SELECT * FROM reviewer_invitation_acceptances").all()).toEqual([{
        invitation_id: "invite-upgrade-accepted",
        event_id: "evt-devflow",
        user_id: "usr-upgrade-reviewer",
        accepted_at: "2026-08-13T13:00:00Z",
      }]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const fresh = new DatabaseSync(":memory:");
      fresh.exec("PRAGMA foreign_keys = ON");
      try {
        for (const name of names) fresh.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
        expect(invitationSchema(database)).toEqual(invitationSchema(fresh));
      } finally {
        fresh.close();
      }

      database.prepare(`UPDATE message_outbox SET canceled_at = '2026-08-15T12:00:00Z',
        cancellation_code = 'MESSAGE_EXPIRED', updated_at = '2026-08-15T12:00:00Z'
        WHERE id = 'msg-upgrade-pending'`).run();
      database.prepare(`UPDATE reviewer_invitations SET state = 'expired', expired_at = expires_at,
        updated_at = '2026-08-15T12:00:00Z' WHERE id = 'invite-upgrade-pending'`).run();
      expect(database.prepare("SELECT state, expired_at AS expiredAt FROM reviewer_invitations WHERE id = 'invite-upgrade-pending'").get())
        .toEqual({ state: "expired", expiredAt: "2026-08-14T12:00:00Z" });
    } finally {
      database.close();
    }
  });
});
