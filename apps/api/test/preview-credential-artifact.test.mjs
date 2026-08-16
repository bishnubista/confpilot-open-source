import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { derivePasswordHash } from "../src/password";
import {
  preparePreviewCredentials,
  runPreviewCredentialCli,
} from "../scripts/prepare-preview-credentials.mjs";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationNames = [
  "0000_initial.sql",
  "0001_auth_credentials.sql",
  "0002_cfp_drafts.sql",
  "0003_reviewer_workflow.sql",
  "0004_decision_notifications.sql",
  "0005_public_embeds.sql",
  "0006_speaker_content.sql",
  "0007_agenda_publication.sql",
  "0008_workers_password_iterations.sql",
];
const accountInput = {
  accounts: [
    { role: "reviewer", email: "reviewer@preview.example", password: "Reviewer!Preview9Secure" },
    { role: "organizer", email: "organizer@example.com", password: "Organizer!Preview8Secure" },
  ],
};
const temporaryRoots = [];
const guardName = "_confpilot_preview_credential_guard";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "confpilot-preview-credentials-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".wrangler"));
  return root;
}

function writeSecret(root, value = accountInput, mode = 0o600) {
  const path = join(root, ".wrangler", "credentials.json");
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(value), { mode });
  return path;
}

function migrationSql(name) {
  return readFileSync(new URL(name, migrationsUrl), "utf8");
}

function credentialDatabase({ role = "reviewer", reviewerIterations = 600000, extraLegacy = false } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames.slice(0, -1)) database.exec(migrationSql(name));
  database.prepare(`INSERT INTO events (
    id, slug, name, tagline, location, description, starts_on, ends_on, cfp_deadline, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("event-preview", "preview-conf", "Preview Conf", "Preview", "Online", "Synthetic preview event",
      "2027-01-10", "2027-01-11", "2026-12-01T00:00:00Z", "draft");
  database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run("user-organizer", "organizer@example.com", "Organizer", "2026-08-11T00:00:00Z");
  database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run("user-reviewer", "reviewer@preview.example", "Reviewer", "2026-08-11T00:00:00Z");
  database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("membership-organizer", "event-preview", "user-organizer", "organizer", "2026-08-11T00:00:00Z");
  database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("membership-reviewer", "event-preview", "user-reviewer", role, "2026-08-11T00:00:00Z");
  const insertCredential = database.prepare(`INSERT INTO user_credentials (
    user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
  ) VALUES (?, ?, ?, 'pbkdf2-sha256', ?, ?, ?)`);
  insertCredential.run("user-organizer", "1".repeat(32), "2".repeat(64), 600000,
    "2026-08-11T00:00:00Z", "2026-08-11T00:00:00Z");
  insertCredential.run("user-reviewer", "3".repeat(32), "4".repeat(64), 600000,
    "2026-08-11T00:00:00Z", "2026-08-11T00:00:00Z");
  if (extraLegacy) {
    database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("user-extra", "extra@example.net", "Extra", "2026-08-11T00:00:00Z");
    insertCredential.run("user-extra", "9".repeat(32), "a".repeat(64), 600000,
      "2026-08-11T00:00:00Z", "2026-08-11T00:00:00Z");
  }
  const insertSession = database.prepare(`INSERT INTO auth_sessions (
    id, user_id, token_hash, expires_at, revoked_at, created_at
  ) VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, '2026-08-11T00:00:00Z')`);
  insertSession.run("session-organizer", "user-organizer", "5".repeat(64));
  insertSession.run("session-reviewer", "user-reviewer", "6".repeat(64));
  database.exec(migrationSql("0008_workers_password_iterations.sql"));
  if (reviewerIterations !== 600000) {
    database.prepare(`UPDATE user_credentials SET password_salt = ?, password_hash = ?, iterations = ?
      WHERE user_id = 'user-reviewer'`).run("7".repeat(32), "8".repeat(64), reviewerIterations);
  }
  return database;
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("preview credential artifact preparation", () => {
  it("creates a mode-0600 artifact that upgrades exactly two credentials and revokes their sessions", async () => {
    const apiRoot = fixtureRoot();
    const inputPath = writeSecret(apiRoot);
    const result = await preparePreviewCredentials({
      apiRoot,
      input: ".wrangler/credentials.json",
      eventSlug: "preview-conf",
      output: ".wrangler/credentials.sql",
    });
    const artifactPath = join(apiRoot, result.output);
    const artifact = readFileSync(artifactPath, "utf8");

    expect(statSync(inputPath).mode & 0o777).toBe(0o600);
    expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    expect(artifact).not.toContain(accountInput.accounts[0].password);
    expect(artifact).not.toContain(accountInput.accounts[1].password);
    expect(artifact.match(/UPDATE "user_credentials"/g)).toHaveLength(1);
    expect(artifact).not.toMatch(/\bTEMP(?:ORARY)?\b/i);
    expect(artifact.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(artifact).not.toContain('CREATE TABLE "credential_targets"');

    const database = credentialDatabase();
    try {
      database.exec(artifact);
      const credentials = database.prepare(`SELECT lower(trim(user.email)) AS email,
        credential.password_salt AS salt, credential.password_hash AS hash,
        credential.algorithm, credential.iterations
        FROM user_credentials credential INNER JOIN users user ON user.id = credential.user_id
        ORDER BY email`).all();
      expect(credentials).toHaveLength(2);
      expect(new Set(credentials.map(({ salt }) => salt)).size).toBe(2);
      expect(credentials.every(({ salt }) => /^[0-9a-f]{32}$/.test(salt))).toBe(true);
      expect(credentials.every(({ hash }) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
      expect(credentials.every(({ algorithm, iterations }) =>
        algorithm === "pbkdf2-sha256" && iterations === 100000)).toBe(true);
      for (const credential of credentials) {
        const source = accountInput.accounts.find(({ email }) => email.trim().toLowerCase() === credential.email);
        expect(await derivePasswordHash(source.password, credential.salt, credential.iterations)).toBe(credential.hash);
      }
      expect(database.prepare(`SELECT COUNT(*) AS count FROM auth_sessions
        WHERE user_id IN ('user-organizer', 'user-reviewer') AND revoked_at IS NULL`).get()).toEqual({ count: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare(`SELECT name FROM sqlite_master
        WHERE name = ?`).all(guardName)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("does not emit email, password, salt, or hash material to stdout", async () => {
    const apiRoot = fixtureRoot();
    writeSecret(apiRoot);
    const output = [];
    await runPreviewCredentialCli({
      apiRoot,
      argv: [
        "--input", ".wrangler/credentials.json",
        "--event-slug", "preview-conf",
        "--output", ".wrangler/credentials.sql",
      ],
      log: (line) => output.push(line),
    });
    const logs = output.join("\n");
    const artifact = readFileSync(join(apiRoot, ".wrangler", "credentials.sql"), "utf8");
    for (const account of accountInput.accounts) {
      expect(logs).not.toContain(account.email.trim().toLowerCase());
      expect(logs).not.toContain(account.password);
    }
    for (const secret of artifact.match(/[0-9a-f]{32,64}/g) ?? []) expect(logs).not.toContain(secret);
    expect(logs).toContain("2 required preview roles");
    expect(logs).toContain("No database command was executed");
  });

  it("fails closed when a target membership role or legacy work factor is wrong", async () => {
    const apiRoot = fixtureRoot();
    writeSecret(apiRoot);
    const { output } = await preparePreviewCredentials({
      apiRoot,
      input: ".wrangler/credentials.json",
      eventSlug: "preview-conf",
      output: ".wrangler/credentials.sql",
    });
    const artifact = readFileSync(join(apiRoot, output), "utf8");

    for (const database of [credentialDatabase({ role: "speaker" }), credentialDatabase({ reviewerIterations: 100000 })]) {
      try {
        expect(() => database.exec(artifact)).toThrow(/CHECK constraint failed/);
        expect(database.prepare("SELECT iterations FROM user_credentials WHERE user_id = 'user-organizer'").get())
          .toEqual({ iterations: 600000 });
      } finally {
        database.close();
      }
    }
  });

  it("keeps every interrupted statement prefix in a safe, audit-required state", async () => {
    const apiRoot = fixtureRoot();
    writeSecret(apiRoot);
    const { output } = await preparePreviewCredentials({
      apiRoot,
      input: ".wrangler/credentials.json",
      eventSlug: "preview-conf",
      output: ".wrangler/credentials.sql",
    });
    const artifact = readFileSync(join(apiRoot, output), "utf8");
    const boundaries = [
      { before: 'WITH "credential_targets" (', occurrence: 1, activeSessions: 2, iterations: 600000 },
      { before: 'WITH "credential_targets" (', occurrence: 2, activeSessions: 2, iterations: 600000 },
      { before: 'WITH "credential_targets" (', occurrence: 3, activeSessions: 0, iterations: 600000 },
      { before: 'WITH "credential_targets" (', occurrence: 4, activeSessions: 0, iterations: 600000 },
      { before: 'WITH "credential_targets" (', occurrence: 5, activeSessions: 0, iterations: 100000 },
      { before: 'DROP TABLE "_confpilot_preview_credential_guard";', occurrence: 1, activeSessions: 0, iterations: 100000 },
    ];
    for (const boundary of boundaries) {
      let index = -1;
      let from = 0;
      for (let count = 0; count < boundary.occurrence; count += 1) {
        index = artifact.indexOf(boundary.before, from);
        from = index + boundary.before.length;
      }
      expect(index).toBeGreaterThan(0);
      const interrupted = `${artifact.slice(0, index)}INSERT INTO "_confpilot_forced_failure" VALUES (1);`;
      const database = credentialDatabase();
      try {
        expect(() => database.exec(interrupted)).toThrow(/no such table/);
        expect(database.prepare("SELECT DISTINCT iterations FROM user_credentials").all())
          .toEqual([{ iterations: boundary.iterations }]);
        expect(database.prepare(`SELECT COUNT(*) AS count FROM auth_sessions
          WHERE user_id IN ('user-organizer', 'user-reviewer') AND revoked_at IS NULL`).get())
          .toEqual({ count: boundary.activeSessions });
        const persistentGuard = database.prepare("SELECT name, sql FROM sqlite_master WHERE name = ?").get(guardName);
        expect(persistentGuard.name).toBe(guardName);
        expect(persistentGuard.sql).not.toContain("email");
        expect(persistentGuard.sql).not.toContain("password");
        for (const account of accountInput.accounts) expect(persistentGuard.sql).not.toContain(account.email);
        for (const secret of artifact.match(/[0-9a-f]{32,64}/g) ?? []) expect(persistentGuard.sql).not.toContain(secret);
        expect(() => database.exec(artifact)).toThrow(/already exists/);
      } finally {
        database.close();
      }
    }
  });

  it("rejects an unexpected third legacy credential before updating any target", async () => {
    const apiRoot = fixtureRoot();
    writeSecret(apiRoot);
    const { output } = await preparePreviewCredentials({
      apiRoot,
      input: ".wrangler/credentials.json",
      eventSlug: "preview-conf",
      output: ".wrangler/credentials.sql",
    });
    const artifact = readFileSync(join(apiRoot, output), "utf8");
    const database = credentialDatabase({ extraLegacy: true });
    try {
      expect(() => database.exec(artifact)).toThrow(/CHECK constraint failed/);
      expect(database.prepare("SELECT iterations FROM user_credentials WHERE user_id IN ('user-organizer', 'user-reviewer') ORDER BY user_id").all())
        .toEqual([{ iterations: 600000 }, { iterations: 600000 }]);
    } finally {
      database.close();
    }
  });

  it("rejects non-secret paths, permissive modes, malformed account sets, and weak credentials", async () => {
    const apiRoot = fixtureRoot();
    writeSecret(apiRoot, accountInput, 0o644);
    await expect(preparePreviewCredentials({
      apiRoot, input: ".wrangler/credentials.json", eventSlug: "preview-conf", output: ".wrangler/out.sql",
    })).rejects.toThrow("mode 0600");

    writeSecret(apiRoot, {
      accounts: [
        { role: "organizer", email: "person@not-reserved.test", password: "Organizer!Preview8Secure" },
        { role: "organizer", email: "other@example.com", password: "weak" },
      ],
    });
    await expect(preparePreviewCredentials({
      apiRoot, input: ".wrangler/credentials.json", eventSlug: "preview-conf", output: ".wrangler/out.sql",
    })).rejects.toThrow(/reserved|one organizer/i);

    writeSecret(apiRoot, {
      accounts: [
        { role: "organizer", email: "person@example.com.evil.test", password: "Organizer!Preview8Secure" },
        { role: "reviewer", email: "other@devflow.example.evil", password: "Reviewer!Preview9Secure" },
      ],
    });
    await expect(preparePreviewCredentials({
      apiRoot, input: ".wrangler/credentials.json", eventSlug: "preview-conf", output: ".wrangler/out.sql",
    })).rejects.toThrow("reserved example namespace");

    writeSecret(apiRoot, {
      accounts: [
        { role: "organizer", email: " Organizer@Example.com ", password: "Organizer!Preview8Secure" },
        { role: "reviewer", email: "reviewer@preview.example", password: "Reviewer!Preview9Secure" },
      ],
    });
    await expect(preparePreviewCredentials({
      apiRoot, input: ".wrangler/credentials.json", eventSlug: "preview-conf", output: ".wrangler/out.sql",
    })).rejects.toThrow("already be normalized");

    writeSecret(apiRoot, {
      accounts: [
        { role: "organizer", email: "person@example.com", password: "Organizer!Preview8Secure" },
        { role: "reviewer", email: "other@example.org", password: "weak" },
      ],
    });
    await expect(preparePreviewCredentials({
      apiRoot, input: ".wrangler/credentials.json", eventSlug: "preview-conf", output: ".wrangler/out.sql",
    })).rejects.toThrow("Passwords must be 16-128 characters");

    writeSecret(apiRoot, {
      accounts: [
        { role: "organizer", email: "person@example.com", password: "Organizer!Preview8Secure" },
        { role: "organizer", email: "other@example.org", password: "OtherRole!Preview7Secure" },
      ],
    });
    await expect(preparePreviewCredentials({
      apiRoot, input: ".wrangler/credentials.json", eventSlug: "preview-conf", output: ".wrangler/out.sql",
    })).rejects.toThrow("one organizer and one reviewer");
    await expect(preparePreviewCredentials({
      apiRoot, input: "credentials.json", eventSlug: "preview-conf", output: ".wrangler/out.sql",
    })).rejects.toThrow("ignored .wrangler or .codex");
  });

  it("refuses to overwrite an existing artifact", async () => {
    const apiRoot = fixtureRoot();
    writeSecret(apiRoot);
    const options = {
      apiRoot, input: ".wrangler/credentials.json", eventSlug: "preview-conf", output: ".wrangler/credentials.sql",
    };
    await preparePreviewCredentials(options);
    await expect(preparePreviewCredentials(options)).rejects.toThrow(/exist/i);
  });
});
