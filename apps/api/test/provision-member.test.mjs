import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";
import { derivePasswordHash } from "../src/password.ts";
import { REQUIRED_MIGRATION, prepareMemberProvisioning, runProvisionMemberCli } from "../scripts/provision-member.mjs";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const password = "Reviewer!SelfHost9Secure";
const validInput = {
  eventSlug: "community-conf",
  role: "reviewer",
  member: { email: "reviewer@community.example", displayName: "Riley Reviewer", password },
};
const temporaryRoots = [];

class SqliteD1Statement {
  constructor(statement) { this.statement = statement; this.params = []; }
  bind(...params) { const bound = new SqliteD1Statement(this.statement); bound.params = params; return bound; }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
  async run() {
    const result = this.statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first(column) {
    const row = this.statement.get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }
}

class SqliteD1Database {
  constructor(database) { this.database = database; }
  prepare(query) { return new SqliteD1Statement(this.database.prepare(query)); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixtureRoot({ initializeGit = true, gitignore = ".wrangler/\n.codex/\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "confpilot-reviewer-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".wrangler"));
  writeFileSync(join(root, ".gitignore"), gitignore);
  if (initializeGit) execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function writeInput(root, value = validInput, mode = 0o600) {
  const path = join(root, ".wrangler", "reviewer.json");
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(value), { mode });
  return path;
}

function migratedDatabase({ eventSlug = "community-conf", recordedMigrations = migrationNames } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  database.exec(`CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const recordMigration = database.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  for (const name of recordedMigrations) recordMigration.run(name);
  if (eventSlug) {
    database.prepare(`INSERT INTO events (
      id, slug, name, tagline, location, description, starts_on, ends_on, cfp_deadline, status, time_zone
    ) VALUES ('event-community', ?, 'Community Conf', '', 'Online', '', '2027-06-10', '2027-06-11',
      '2027-05-01T23:59:00Z', 'published', 'America/Los_Angeles')`).run(eventSlug);
  }
  return database;
}

async function artifact(root, value = validInput) {
  writeInput(root, value);
  const result = await prepareMemberProvisioning({
    apiRoot: root, input: ".wrangler/reviewer.json", output: ".wrangler/reviewer.sql",
  });
  return { result, sql: readFileSync(join(root, result.output), "utf8") };
}

const sameOriginHeaders = {
  Origin: "http://localhost",
  "Content-Type": "application/json",
  "X-ConfPilot-Request": "1",
  "Sec-Fetch-Site": "same-origin",
};
const allowRateLimiter = { limit: async () => ({ success: true }) };

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("reviewer provisioning artifact", () => {
  it("pins its gate to the latest tracked migration", () => {
    const trackedMigrations = readdirSync(migrationsUrl)
      .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    expect(REQUIRED_MIGRATION).toBe(trackedMigrations.at(-1));
  });

  it("creates a login-capable event reviewer visible only through reviewer-authorized APIs", async () => {
    const root = fixtureRoot();
    const { result, sql } = await artifact(root);
    expect(result.eventSlug).toBe("community-conf");
    expect(statSync(join(root, result.output)).mode & 0o777).toBe(0o600);
    expect(sql).not.toContain(password);
    expect(sql).not.toMatch(/wrangler|d1 execute|fetch\(/i);

    const database = migratedDatabase();
    database.exec(sql);
    expect(database.prepare(`SELECT users.email, memberships.role FROM users
      INNER JOIN event_memberships AS memberships ON memberships.user_id = users.id`).get()).toEqual({
      email: "reviewer@community.example", role: "reviewer",
    });
    const credential = database.prepare(`SELECT password_salt AS salt, password_hash AS hash,
      algorithm, iterations FROM user_credentials`).get();
    expect(await derivePasswordHash(password, credential.salt, credential.iterations)).toBe(credential.hash);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_member_guard'").get()).toBeUndefined();

    const env = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: allowRateLimiter,
      LOGIN_ACCOUNT_RATE_LIMITER: allowRateLimiter,
    };
    const login = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ email: validInput.member.email, password }),
    }, env);
    expect(login.status).toBe(200);
    const loginBody = await login.json();
    expect(loginBody.data.memberships).toEqual([{ eventSlug: "community-conf", role: "reviewer" }]);
    const cookie = /__Host-confpilot_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    expect(cookie).toBeTruthy();

    const queue = await createApp().request("/api/events/community-conf/review/assignments", {
      headers: { Cookie: `__Host-confpilot_session=${cookie}` },
    }, env);
    expect(queue.status).toBe(200);
    expect((await queue.json()).data.assignments).toEqual([]);

    const organizerOnly = await createApp().request("/api/events/community-conf/cfp/reviewers", {
      headers: { Cookie: `__Host-confpilot_session=${cookie}` },
    }, env);
    expect(organizerOnly.status).toBe(403);
    database.close();
  });

  it("grants an organizer or reviewer role on a populated instance", async () => {
    for (const role of ["organizer", "reviewer"]) {
      const root = fixtureRoot();
      const { result, sql } = await artifact(root, { ...validInput, role });
      expect(result.role).toBe(role);

      const database = migratedDatabase();
      database.exec(sql);
      expect(database.prepare("SELECT role FROM event_memberships").get()).toEqual({ role });
      expect(database.prepare("SELECT COUNT(*) AS count FROM user_credentials").get().count).toBe(1);
      database.close();
    }
  });

  it("leaves a detectable and recoverable partial apply when the final guard fails", async () => {
    const root = fixtureRoot();
    const { sql } = await artifact(root);
    const guardFailureSql = sql.replace("THEN 1 ELSE 0 END;", "THEN 0 ELSE 0 END;");
    expect(guardFailureSql).not.toBe(sql);

    const database = migratedDatabase();
    expect(() => database.exec(guardFailureSql)).toThrow(/CHECK constraint failed/);
    expect(database.prepare("SELECT email FROM users").get()).toEqual({ email: validInput.member.email });
    expect(database.prepare("SELECT role FROM event_memberships").get()).toEqual({ role: "reviewer" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_member_guard'").get())
      .toEqual({ name: "_confpilot_member_guard" });

    // A retry is blocked by the normalized-email precondition until the partial rows are removed.
    expect(() => database.exec(sql)).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(1);

    database.exec(`
      DELETE FROM event_memberships WHERE user_id = (SELECT id FROM users WHERE email = '${validInput.member.email}');
      DELETE FROM user_credentials WHERE user_id = (SELECT id FROM users WHERE email = '${validInput.member.email}');
      DELETE FROM users WHERE email = '${validInput.member.email}';
      DROP TABLE _confpilot_member_guard;
    `);
    database.exec(sql);
    expect(database.prepare("SELECT email FROM users").get()).toEqual({ email: validInput.member.email });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_member_guard'").get())
      .toBeUndefined();
    database.close();
  });

  // `speaker` is refused even though the database would accept the membership:
  // the portal needs a `speakers` row that only CFP registration creates.
  it.each(["administrator", "speaker"])("refuses to provision the %s role", async (role) => {
    const root = fixtureRoot();
    writeInput(root, { ...validInput, role });
    await expect(prepareMemberProvisioning({
      apiRoot: root, input: ".wrangler/reviewer.json", output: ".wrangler/reviewer.sql",
    })).rejects.toThrow(/Role must be one of/);
    expect(() => statSync(join(root, ".wrangler", "reviewer.sql"))).toThrow();
  });

  it("fails before mutation for a missing event or missing final migration ledger entry", async () => {
    const root = fixtureRoot();
    const { sql } = await artifact(root);
    for (const database of [
      migratedDatabase({ eventSlug: null }),
      migratedDatabase({ recordedMigrations: migrationNames.slice(0, -1) }),
    ]) {
      expect(() => database.exec(sql)).toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM user_credentials").get().count).toBe(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM event_memberships").get().count).toBe(0);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_member_guard'").get()).toBeUndefined();
      database.close();
    }
  });

  it("fails before mutation when the normalized email already exists", async () => {
    const root = fixtureRoot();
    const { sql } = await artifact(root);
    const database = migratedDatabase();
    database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("existing-user", " Reviewer@Community.Example ", "Existing", "2026-08-11T00:00:00Z");
    expect(() => database.exec(sql)).toThrow();
    expect(database.prepare("SELECT id, email FROM users").all()).toEqual([
      { id: "existing-user", email: " Reviewer@Community.Example " },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM user_credentials").get().count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM event_memberships").get().count).toBe(0);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_member_guard'").get()).toBeUndefined();
    database.close();
  });

  it.each([
    ["slug", { ...validInput, eventSlug: "Bad Slug" }],
    ["email normalization", { ...validInput, member: { ...validInput.member, email: "Reviewer@community.example" } }],
    ["weak password", { ...validInput, member: { ...validInput.member, password: "weak" } }],
    ["unexpected property", { ...validInput, member: { ...validInput.member, role: "organizer" } }],
  ])("rejects invalid %s input", async (_label, value) => {
    const root = fixtureRoot();
    writeInput(root, value);
    await expect(prepareMemberProvisioning({
      apiRoot: root, input: ".wrangler/reviewer.json", output: ".wrangler/reviewer.sql",
    })).rejects.toThrow();
  });

  it("requires ignored relative paths, a regular 0600 input, and a new output", async () => {
    const root = fixtureRoot();
    const inputPath = writeInput(root);
    chmodSync(inputPath, 0o644);
    await expect(prepareMemberProvisioning({ apiRoot: root, input: ".wrangler/reviewer.json", output: ".wrangler/reviewer.sql" }))
      .rejects.toThrow(/0600/);
    chmodSync(inputPath, 0o600);
    symlinkSync(inputPath, join(root, ".wrangler", "linked.json"));
    await expect(prepareMemberProvisioning({ apiRoot: root, input: ".wrangler/linked.json", output: ".wrangler/reviewer.sql" }))
      .rejects.toThrow(/regular file/);
    await expect(prepareMemberProvisioning({ apiRoot: root, input: "reviewer.json", output: ".wrangler/reviewer.sql" }))
      .rejects.toThrow(/ignored/);
    writeFileSync(join(root, ".wrangler", "reviewer.sql"), "existing", { mode: 0o600 });
    await expect(prepareMemberProvisioning({ apiRoot: root, input: ".wrangler/reviewer.json", output: ".wrangler/reviewer.sql" }))
      .rejects.toThrow(/refusing to overwrite/);
  });

  it("requires Git-ignore coverage for both credential input and artifact output", async () => {
    const unignoredInputRoot = fixtureRoot({ gitignore: ".wrangler/*.sql\n" });
    writeInput(unignoredInputRoot);
    await expect(prepareMemberProvisioning({
      apiRoot: unignoredInputRoot,
      input: ".wrangler/reviewer.json",
      output: ".wrangler/reviewer.sql",
    })).rejects.toThrow("Input must be ignored by Git before credential data is read or written.");
    expect(() => statSync(join(unignoredInputRoot, ".wrangler", "reviewer.sql"))).toThrow();

    const unignoredOutputRoot = fixtureRoot({ gitignore: ".wrangler/*.json\n" });
    writeInput(unignoredOutputRoot);
    await expect(prepareMemberProvisioning({
      apiRoot: unignoredOutputRoot,
      input: ".wrangler/reviewer.json",
      output: ".wrangler/reviewer.sql",
    })).rejects.toThrow("Output must be ignored by Git before credential data is read or written.");
    expect(() => statSync(join(unignoredOutputRoot, ".wrangler", "reviewer.sql"))).toThrow();
  });

  it("distinguishes a missing Git checkout, missing Git, and an unexpected ignore-check failure", async () => {
    const archiveRoot = fixtureRoot({ initializeGit: false });
    writeInput(archiveRoot);
    await expect(prepareMemberProvisioning({
      apiRoot: archiveRoot,
      input: ".wrangler/reviewer.json",
      output: ".wrangler/reviewer.sql",
    })).rejects.toThrow("must be prepared from a Git checkout");
    expect(() => statSync(join(archiveRoot, ".wrangler", "reviewer.sql"))).toThrow();

    const missingGitRoot = fixtureRoot();
    writeInput(missingGitRoot);
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(prepareMemberProvisioning({
        apiRoot: missingGitRoot,
        input: ".wrangler/reviewer.json",
        output: ".wrangler/reviewer.sql",
      })).rejects.toThrow("Git is required to verify");
    } finally {
      process.env.PATH = originalPath;
    }
    expect(() => statSync(join(missingGitRoot, ".wrangler", "reviewer.sql"))).toThrow();

    const failedCheckRoot = fixtureRoot();
    writeInput(failedCheckRoot);
    const originalIndexFile = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = join(failedCheckRoot, ".git");
    try {
      await expect(prepareMemberProvisioning({
        apiRoot: failedCheckRoot,
        input: ".wrangler/reviewer.json",
        output: ".wrangler/reviewer.sql",
      })).rejects.toThrow("Git could not verify credential path ignore coverage");
    } finally {
      if (originalIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = originalIndexFile;
    }
    expect(() => statSync(join(failedCheckRoot, ".wrangler", "reviewer.sql"))).toThrow();
  });

  it("refuses an output directory that escapes through a symbolic link", async () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "confpilot-reviewer-outside-"));
    temporaryRoots.push(outside);
    writeInput(root);
    symlinkSync(outside, join(root, ".wrangler", "linked-output"));
    await expect(prepareMemberProvisioning({
      apiRoot: root, input: ".wrangler/reviewer.json", output: ".wrangler/linked-output/nested/reviewer.sql",
    })).rejects.toThrow(/symbolic link/);
    expect(() => statSync(join(outside, "nested"))).toThrow();
  });

  it("supports pnpm's argument separator without leaking reviewer secrets", async () => {
    const root = fixtureRoot();
    writeInput(root);
    const logs = [];
    await runProvisionMemberCli({
      apiRoot: root,
      argv: ["--", "--input", ".wrangler/reviewer.json", "--output", ".wrangler/reviewer.sql"],
      log: (message) => logs.push(message),
    });
    expect(logs.join("\n")).not.toContain(password);
    expect(logs.join("\n")).not.toContain(validInput.member.email);
    expect(logs.join("\n")).toContain("No database command was executed");
  });
});
