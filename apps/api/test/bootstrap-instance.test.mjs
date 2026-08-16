import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";
import { derivePasswordHash } from "../src/password";
import { REQUIRED_MIGRATION, prepareInstanceBootstrap, runBootstrapCli } from "../scripts/bootstrap-instance.mjs";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const password = "Owner!SelfHost9Secure";
const validInput = {
  event: {
    slug: "community-conf", name: "Community Conf", tagline: "Gather and learn", location: "Online",
    description: "A community-run conference.", startsOn: "2027-06-10", endsOn: "2027-06-11",
    cfpOpensAt: "2026-09-01T00:00:00Z", cfpClosesAt: "2027-05-01T23:59:00Z", timeZone: "America/Los_Angeles",
  },
  owner: { email: "owner@community.example", displayName: "Casey Owner", password },
};
const temporaryRoots = [];

class SqliteD1Statement {
  constructor(statement) {
    this.statement = statement;
    this.params = [];
  }
  bind(...params) {
    const bound = new SqliteD1Statement(this.statement);
    bound.params = params;
    return bound;
  }
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

const sameOriginHeaders = {
  Origin: "http://localhost",
  "Content-Type": "application/json",
  "X-ConfPilot-Request": "1",
  "Sec-Fetch-Site": "same-origin",
};
const allowRateLimiter = { limit: async () => ({ success: true }) };

function cookieToken(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return /__Host-confpilot_session=([^;]+)/.exec(setCookie)?.[1];
}

function fixtureRoot({ initializeGit = true, gitignore = ".wrangler/\n.codex/\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "confpilot-bootstrap-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".wrangler"));
  writeFileSync(join(root, ".gitignore"), gitignore);
  if (initializeGit) execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function writeInput(root, value = validInput, mode = 0o600) {
  const path = join(root, ".wrangler", "bootstrap.json");
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(value), { mode });
  return path;
}

function migratedDatabase(recordedMigrations = migrationNames) {
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
  return database;
}

async function artifact(root, value = validInput) {
  writeInput(root, value);
  const result = await prepareInstanceBootstrap({
    apiRoot: root, input: ".wrangler/bootstrap.json", output: ".wrangler/bootstrap.sql",
  });
  return { result, sql: readFileSync(join(root, result.output), "utf8") };
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("empty-instance bootstrap artifact", () => {
  it("pins its gate to the latest tracked migration", () => {
    const trackedMigrations = readdirSync(migrationsUrl)
      .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    expect(REQUIRED_MIGRATION).toBe(trackedMigrations.at(-1));
  });

  it("creates a 0600 artifact that initializes exactly one usable event and owner", async () => {
    const root = fixtureRoot();
    const { result, sql } = await artifact(root);
    expect(result.eventSlug).toBe("community-conf");
    expect(statSync(join(root, result.output)).mode & 0o777).toBe(0o600);
    expect(sql).not.toContain(password);
    expect(sql).not.toMatch(/wrangler|d1 execute|fetch\(/i);

    const database = migratedDatabase();
    database.exec(sql);
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get().count).toBe(1);
    expect(database.prepare("SELECT slug, status, time_zone AS timeZone FROM events").get()).toEqual({
      slug: "community-conf", status: "published", timeZone: "America/Los_Angeles",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(1);
    expect(database.prepare("SELECT role FROM event_memberships").get().role).toBe("organizer");
    expect(database.prepare("SELECT status FROM cfp_configs").get().status).toBe("published");
    expect(database.prepare("SELECT confirmation_message AS message FROM cfp_configs").get()).toEqual({
      message: "Thanks for sharing your proposal. You can view its status from this account.",
    });
    expect(database.prepare("SELECT field_key AS key FROM cfp_fields ORDER BY sort_order").all())
      .toEqual([{ key: "title" }, { key: "abstract" }, { key: "track" }, { key: "format" }]);
    const credential = database.prepare(`SELECT password_salt AS salt, password_hash AS hash,
      algorithm, iterations FROM user_credentials`).get();
    expect(credential.algorithm).toBe("pbkdf2-sha256");
    expect(credential.iterations).toBe(100000);
    expect(await derivePasswordHash(password, credential.salt, credential.iterations)).toBe(credential.hash);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_bootstrap_guard'").get()).toBeUndefined();

    const env = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: allowRateLimiter,
      LOGIN_ACCOUNT_RATE_LIMITER: allowRateLimiter,
    };
    const response = await createApp().request("/api/cfp/community-conf", undefined, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        event: { slug: "community-conf", name: "Community Conf" },
        status: "published",
        fields: [
          { key: "title" }, { key: "abstract" }, { key: "track" }, { key: "format" },
        ],
      },
    });

    const login = await createApp().request("http://localhost/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ email: validInput.owner.email, password }),
    }, env);
    expect(login.status).toBe(200);
    const token = cookieToken(login);
    expect(token).toMatch(/\S+/);
    const session = await createApp().request("http://localhost/api/auth/session", {
      headers: { Cookie: `__Host-confpilot_session=${token}` },
    }, env);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      data: {
        user: { email: validInput.owner.email },
        memberships: [{ eventSlug: "community-conf", role: "organizer" }],
      },
    });
    const storedSession = database.prepare("SELECT token_hash AS hash FROM auth_sessions").get();
    expect(storedSession.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedSession.hash).not.toContain(token);
    database.close();
  });

  it("leaves a detectable and recoverable partial apply when the final guard fails", async () => {
    const root = fixtureRoot();
    const { sql } = await artifact(root);
    const guardFailureSql = sql.replace("THEN 1 ELSE 0 END;", "THEN 0 ELSE 0 END;");
    expect(guardFailureSql).not.toBe(sql);

    const database = migratedDatabase();
    expect(() => database.exec(guardFailureSql)).toThrow(/CHECK constraint failed/);
    expect(database.prepare("SELECT slug FROM events").get()).toEqual({ slug: "community-conf" });
    expect(database.prepare("SELECT email FROM users").get()).toEqual({ email: validInput.owner.email });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_bootstrap_guard'").get())
      .toEqual({ name: "_confpilot_bootstrap_guard" });
    expect(() => database.exec(sql)).toThrow();

    database.exec(`
      DELETE FROM cfp_fields;
      DELETE FROM cfp_configs;
      DELETE FROM event_memberships;
      DELETE FROM user_credentials;
      DELETE FROM users;
      DELETE FROM events;
      DROP TABLE _confpilot_bootstrap_guard;
    `);
    database.exec(sql);
    expect(database.prepare("SELECT slug FROM events").get()).toEqual({ slug: "community-conf" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_bootstrap_guard'").get())
      .toBeUndefined();
    database.close();
  });

  it("fails closed on a non-empty instance", async () => {
    const root = fixtureRoot();
    const { sql } = await artifact(root);
    const database = migratedDatabase();
    database.prepare(`INSERT INTO events (id, slug, name, tagline, location, description, starts_on, ends_on,
      cfp_deadline, status) VALUES (?, ?, ?, '', ?, '', ?, ?, ?, 'draft')`)
      .run("existing", "existing", "Existing", "Online", "2027-01-01", "2027-01-01", "2026-12-01T00:00:00Z");
    expect(() => database.exec(sql)).toThrow();
    expect(database.prepare("SELECT slug FROM events").all()).toEqual([{ slug: "existing" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(0);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_bootstrap_guard'").get()).toBeUndefined();
  });

  it("fails before mutation unless the final required migration is recorded", async () => {
    const root = fixtureRoot();
    const { sql } = await artifact(root);
    const database = migratedDatabase(migrationNames.slice(0, -1));
    expect(() => database.exec(sql)).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get().count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM users").get().count).toBe(0);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_bootstrap_guard'").get()).toBeUndefined();
  });

  it("quotes operator-controlled text as SQL data", async () => {
    const root = fixtureRoot();
    const quoted = {
      ...validInput,
      event: { ...validInput.event, name: "Builders' Community" },
      owner: { ...validInput.owner, displayName: "Casey O'Owner" },
    };
    const { sql } = await artifact(root, quoted);
    const database = migratedDatabase();
    database.exec(sql);
    expect(database.prepare("SELECT name FROM events").get().name).toBe("Builders' Community");
    expect(database.prepare("SELECT display_name AS name FROM users").get().name).toBe("Casey O'Owner");
  });

  it.each([
    ["slug", { ...validInput, event: { ...validInput.event, slug: "Bad Slug" } }],
    ["calendar date", { ...validInput, event: { ...validInput.event, startsOn: "2027-02-30" } }],
    ["date order", { ...validInput, event: { ...validInput.event, endsOn: "2027-01-01" } }],
    ["CFP order", { ...validInput, event: { ...validInput.event, cfpClosesAt: "2026-08-01T00:00:00Z" } }],
    ["CFP open precision", { ...validInput, event: { ...validInput.event, cfpOpensAt: "2026-09-01T00:00:00.000Z" } }],
    ["CFP close precision", { ...validInput, event: { ...validInput.event, cfpClosesAt: "2027-05-01T23:59:00.000Z" } }],
    ["time zone", { ...validInput, event: { ...validInput.event, timeZone: "Mars/Olympus" } }],
    ["email normalization", { ...validInput, owner: { ...validInput.owner, email: "Owner@community.example" } }],
    ["weak password", { ...validInput, owner: { ...validInput.owner, password: "weak" } }],
  ])("rejects invalid %s input", async (_label, value) => {
    const root = fixtureRoot();
    writeInput(root, value);
    await expect(prepareInstanceBootstrap({
      apiRoot: root, input: ".wrangler/bootstrap.json", output: ".wrangler/bootstrap.sql",
    })).rejects.toThrow();
  });

  it("requires a regular 0600 input and refuses symlinks and output overwrite", async () => {
    const root = fixtureRoot();
    const inputPath = writeInput(root);
    chmodSync(inputPath, 0o644);
    await expect(prepareInstanceBootstrap({ apiRoot: root, input: ".wrangler/bootstrap.json", output: ".wrangler/bootstrap.sql" }))
      .rejects.toThrow(/0600/);
    chmodSync(inputPath, 0o600);
    symlinkSync(inputPath, join(root, ".wrangler", "linked.json"));
    await expect(prepareInstanceBootstrap({ apiRoot: root, input: ".wrangler/linked.json", output: ".wrangler/bootstrap.sql" }))
      .rejects.toThrow(/regular file/);
    writeFileSync(join(root, ".wrangler", "bootstrap.sql"), "existing", { mode: 0o600 });
    await expect(prepareInstanceBootstrap({ apiRoot: root, input: ".wrangler/bootstrap.json", output: ".wrangler/bootstrap.sql" }))
      .rejects.toThrow(/refusing to overwrite/);
  });

  it("requires Git-ignore coverage for both credential input and artifact output", async () => {
    const unignoredInputRoot = fixtureRoot({ gitignore: ".wrangler/*.sql\n" });
    writeInput(unignoredInputRoot);
    await expect(prepareInstanceBootstrap({
      apiRoot: unignoredInputRoot,
      input: ".wrangler/bootstrap.json",
      output: ".wrangler/bootstrap.sql",
    })).rejects.toThrow("Input must be ignored by Git before credential data is read or written.");
    expect(() => statSync(join(unignoredInputRoot, ".wrangler", "bootstrap.sql"))).toThrow();

    const unignoredOutputRoot = fixtureRoot({ gitignore: ".wrangler/*.json\n" });
    writeInput(unignoredOutputRoot);
    await expect(prepareInstanceBootstrap({
      apiRoot: unignoredOutputRoot,
      input: ".wrangler/bootstrap.json",
      output: ".wrangler/bootstrap.sql",
    })).rejects.toThrow("Output must be ignored by Git before credential data is read or written.");
    expect(() => statSync(join(unignoredOutputRoot, ".wrangler", "bootstrap.sql"))).toThrow();
  });

  it("distinguishes a missing Git checkout, missing Git, and an unexpected ignore-check failure", async () => {
    const archiveRoot = fixtureRoot({ initializeGit: false });
    writeInput(archiveRoot);
    await expect(prepareInstanceBootstrap({
      apiRoot: archiveRoot,
      input: ".wrangler/bootstrap.json",
      output: ".wrangler/bootstrap.sql",
    })).rejects.toThrow("must be prepared from a Git checkout");
    expect(() => statSync(join(archiveRoot, ".wrangler", "bootstrap.sql"))).toThrow();

    const missingGitRoot = fixtureRoot();
    writeInput(missingGitRoot);
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(prepareInstanceBootstrap({
        apiRoot: missingGitRoot,
        input: ".wrangler/bootstrap.json",
        output: ".wrangler/bootstrap.sql",
      })).rejects.toThrow("Git is required to verify");
    } finally {
      process.env.PATH = originalPath;
    }
    expect(() => statSync(join(missingGitRoot, ".wrangler", "bootstrap.sql"))).toThrow();

    const failedCheckRoot = fixtureRoot();
    writeInput(failedCheckRoot);
    const originalIndexFile = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = join(failedCheckRoot, ".git");
    try {
      await expect(prepareInstanceBootstrap({
        apiRoot: failedCheckRoot,
        input: ".wrangler/bootstrap.json",
        output: ".wrangler/bootstrap.sql",
      })).rejects.toThrow("Git could not verify credential path ignore coverage");
    } finally {
      if (originalIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = originalIndexFile;
    }
    expect(() => statSync(join(failedCheckRoot, ".wrangler", "bootstrap.sql"))).toThrow();
  });

  it("refuses an output directory that escapes through a symbolic link", async () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "confpilot-bootstrap-outside-"));
    temporaryRoots.push(outside);
    writeInput(root);
    symlinkSync(outside, join(root, ".wrangler", "linked-output"));
    await expect(prepareInstanceBootstrap({
      apiRoot: root, input: ".wrangler/bootstrap.json", output: ".wrangler/linked-output/nested/bootstrap.sql",
    })).rejects.toThrow(/symbolic link/);
    expect(() => statSync(join(outside, "nested"))).toThrow();
  });

  it("keeps secrets out of CLI output and performs no database operation", async () => {
    const root = fixtureRoot();
    writeInput(root);
    const logs = [];
    await runBootstrapCli({
      apiRoot: root,
      argv: ["--", "--input", ".wrangler/bootstrap.json", "--output", ".wrangler/bootstrap.sql"],
      log: (message) => logs.push(message),
    });
    expect(logs.join("\n")).not.toContain(password);
    expect(logs.join("\n")).not.toContain(validInput.owner.email);
    expect(logs.join("\n")).toContain("No database command was executed");
  });
});
