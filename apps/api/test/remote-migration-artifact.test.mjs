import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prepareRemoteMigration, runRemoteMigrationCli } from "../scripts/prepare-remote-migration.mjs";

const sourceMigrations = new URL("../migrations/", import.meta.url);
const sourceApiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The pinned Wrangler, invoked directly rather than through `pnpm exec`.
 *
 * The certification below spawns Wrangler once per migration and once more to
 * check the result — 27 processes. Going through `pnpm exec` doubles that, and
 * costs ~0.8s each to locate a binary whose path is already known here: ~21s of
 * a 60s budget, spent finding something rather than running it.
 *
 * Nothing about what is exercised changes. Same pinned Wrangler, same
 * subcommands, same local D1 state — this is still the real CLI applying the
 * real artifacts, which is the entire point of the test.
 */
const wranglerBin = join(sourceApiRoot, "node_modules", ".bin", "wrangler");
const migrationNames = readdirSync(sourceMigrations)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();

const temporaryRoots = [];

function fixtureRoot({ initializeGit = true } = {}) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "confpilot-remote-migration-"));
  const apiRoot = join(repositoryRoot, "apps", "api");
  temporaryRoots.push(repositoryRoot);
  mkdirSync(apiRoot, { recursive: true });
  cpSync(sourceMigrations, join(apiRoot, "migrations"), { recursive: true });
  writeFileSync(join(repositoryRoot, ".gitignore"), ".wrangler/\n.codex/\n");
  if (initializeGit) execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
  return apiRoot;
}

function migrationSql(name) {
  return readFileSync(new URL(name, sourceMigrations), "utf8");
}

function predecessorFor(index) {
  return index === 0 ? "none" : migrationNames[index - 1];
}

function databaseThroughPredecessor(targetIndex = migrationNames.length - 1) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  for (const name of migrationNames.slice(0, targetIndex)) {
    database.exec(migrationSql(name));
    database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  }
  return database;
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("remote migration artifact preparation", () => {
  it("prepares and applies the complete catalog in exact order to a fresh database", async () => {
    const apiRoot = fixtureRoot();
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");

    try {
      for (const [index, migration] of migrationNames.entries()) {
        const result = await prepareRemoteMigration({
          apiRoot,
          migration,
          predecessor: predecessorFor(index),
        });
        const targetSql = migrationSql(migration);

        expect(result.artifact).toContain(`\n\n${targetSql}\n\n`);
        if (index === 0) {
          expect(result.artifact).toContain('CREATE TABLE IF NOT EXISTS "d1_migrations"');
        } else {
          expect(result.artifact).not.toContain('CREATE TABLE IF NOT EXISTS "d1_migrations"');
        }

        database.exec(result.artifact);

        expect(database.prepare("SELECT name FROM d1_migrations ORDER BY id").all())
          .toEqual(migrationNames.slice(0, index + 1).map((name) => ({ name })));
        expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_remote_migration_guard'").get())
          .toBeUndefined();
      }

      expect(migrationNames.at(-1)).toBe("0025_release_review_guards.sql");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    } finally {
      database.close();
    }
  });

  it("preserves target SQL byte-for-byte, appends the ledger insert, and upgrades a predecessor database", async () => {
    const apiRoot = fixtureRoot();
    const migration = migrationNames.at(-1);
    const predecessor = migrationNames.at(-2);
    const result = await prepareRemoteMigration({
      apiRoot,
      migration,
      predecessor,
    });
    const targetSql = migrationSql(migration);
    const expectedLedger = `INSERT INTO "d1_migrations" ("name")\nVALUES ('${migration}');`;

    expect(result.artifact).toContain(`\n\n${targetSql}\n\n`);
    expect(result.artifact.endsWith(expectedLedger)).toBe(true);
    expect(result.output).toBe(`.wrangler/remote-migrations/${migration}`);
    expect(statSync(join(apiRoot, result.output)).mode & 0o777).toBe(0o600);

    const database = databaseThroughPredecessor();
    try {
      database.exec(result.artifact);

      expect(database.prepare("SELECT name FROM d1_migrations ORDER BY id").all())
        .toEqual(migrationNames.map((name) => ({ name })));
      database.prepare(`INSERT INTO users (id, email, display_name, created_at)
        VALUES ('user-workers', 'workers@example.com', 'Workers User', '2026-08-11T00:00:00Z')`).run();
      database.prepare(`INSERT INTO user_credentials (
        user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
      ) VALUES (?, ?, ?, 'pbkdf2-sha256', 100000, ?, ?)`).run(
        "user-workers", "c".repeat(32), "d".repeat(64),
        "2026-08-11T00:00:00Z", "2026-08-11T00:00:00Z",
      );
      expect(database.prepare("SELECT iterations FROM user_credentials WHERE user_id = ?").get("user-workers"))
        .toEqual({ iterations: 100000 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_outbox'").get())
        .toEqual({ name: "message_outbox" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("speakers_event_contact_email_normalized_unique")).toEqual({
        name: "speakers_event_contact_email_normalized_unique",
      });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials_legacy'").get())
        .toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("initializes an absent ledger and also accepts Wrangler's existing empty ledger for 0000", async () => {
    const apiRoot = fixtureRoot();
    const result = await prepareRemoteMigration({
      apiRoot,
      migration: "0000_initial.sql",
      predecessor: "none",
    });

    for (const precreateLedger of [false, true]) {
      const database = new DatabaseSync(":memory:");
      try {
        if (precreateLedger) {
          database.exec(`CREATE TABLE d1_migrations(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
          )`);
        }
        database.exec(result.artifact);
        expect(database.prepare("SELECT id, name FROM d1_migrations ORDER BY id").all())
          .toEqual([{ id: 1, name: "0000_initial.sql" }]);
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get())
          .toEqual({ name: "events" });
      } finally {
        database.close();
      }
    }
  });

  it("fails closed without recording 0010 when legacy speaker emails normalize to a collision", async () => {
    const apiRoot = fixtureRoot();
    const result = await prepareRemoteMigration({
      apiRoot,
      migration: "0010_speaker_roster_ingest.sql",
      predecessor: "0009_review_criteria_scoring.sql",
    });
    const database = databaseThroughPredecessor(migrationNames.indexOf("0010_speaker_roster_ingest.sql"));
    try {
      database.prepare(`INSERT INTO events (
        id, slug, name, tagline, location, description, starts_on, ends_on, cfp_deadline, status
      ) VALUES (?, ?, ?, '', '', '', '2028-01-01', '2028-01-02', '2027-12-01T00:00:00Z', 'draft')`)
        .run("event-collision", "collision-2028", "Collision 2028");
      const insertSpeaker = database.prepare(`INSERT INTO speakers (
        id, event_id, user_id, slug, name, title, company, bio, contact_email,
        headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
      ) VALUES (?, 'event-collision', NULL, ?, ?, '', '', '', ?, NULL, 'SC', 'incomplete', 'missing', 'private')`);
      insertSpeaker.run("speaker-collision-a", "collision-a", "Collision A", "Speaker@Example.Test");
      insertSpeaker.run("speaker-collision-b", "collision-b", "Collision B", " speaker@example.test ");

      expect(() => database.exec(result.artifact)).toThrow(/UNIQUE constraint failed/i);
      expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ?")
        .get("event-collision").count).toBe(2);
      expect(database.prepare("SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?")
        .get("0010_speaker_roster_ingest.sql").count).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects paths and requires none only for 0000 and the exact prior migration otherwise", async () => {
    const apiRoot = fixtureRoot();
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "../0011_generic_message_outbox.sql",
      predecessor: "0010_speaker_roster_ingest.sql",
    })).rejects.toThrow("exact migration filename");
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0011_generic_message_outbox.sql",
      predecessor: "0009_review_criteria_scoring.sql",
    })).rejects.toThrow("Predecessor mismatch: expected 0010_speaker_roster_ingest.sql");
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0008_workers_password_iterations.sql",
      predecessor: "0006_speaker_content.sql",
    })).rejects.toThrow("Predecessor mismatch: expected 0007_agenda_publication.sql");
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0000_initial.sql",
      predecessor: "0001_auth_credentials.sql",
    })).rejects.toThrow("Predecessor mismatch: expected none");
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0001_auth_credentials.sql",
      predecessor: "none",
    })).rejects.toThrow("Predecessor mismatch: expected 0000_initial.sql");
  });

  it("fails closed before target SQL when the remote ledger would skip a migration", async () => {
    const apiRoot = fixtureRoot();
    const first = await prepareRemoteMigration({
      apiRoot,
      migration: "0000_initial.sql",
      predecessor: "none",
    });
    const skipped = await prepareRemoteMigration({
      apiRoot,
      migration: "0002_cfp_drafts.sql",
      predecessor: "0001_auth_credentials.sql",
    });
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(first.artifact);
      expect(() => database.exec(skipped.artifact)).toThrow(/CHECK constraint failed/);
      expect(database.prepare("SELECT name FROM d1_migrations ORDER BY id").all())
        .toEqual([{ name: "0000_initial.sql" }]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cfp_configs'").get())
        .toBeUndefined();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = '_confpilot_remote_migration_guard'").get())
        .toEqual({ name: "_confpilot_remote_migration_guard" });
    } finally {
      database.close();
    }
  });

  it("fails closed before target SQL when the ledger repeats or contains an unknown row", async () => {
    const apiRoot = fixtureRoot();
    const target = await prepareRemoteMigration({
      apiRoot,
      migration: "0001_auth_credentials.sql",
      predecessor: "0000_initial.sql",
    });

    for (const unexpected of ["0000_initial.sql", "9999_unknown.sql"]) {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec("PRAGMA foreign_keys = ON");
        database.exec(`CREATE TABLE d1_migrations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`);
        database.exec(migrationSql("0000_initial.sql"));
        database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("0000_initial.sql");
        database.prepare("INSERT INTO d1_migrations (id, name) VALUES (?, ?)")
          .run(2, unexpected);

        expect(() => database.exec(target.artifact)).toThrow(/CHECK constraint failed/);
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials'").get())
          .toBeUndefined();
      } finally {
        database.close();
      }
    }
  });

  it("fails closed before target SQL when the ledger contains an extra NULL name", async () => {
    const apiRoot = fixtureRoot();
    const target = await prepareRemoteMigration({
      apiRoot,
      migration: "0001_auth_credentials.sql",
      predecessor: "0000_initial.sql",
    });
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE d1_migrations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`);
      database.exec(migrationSql("0000_initial.sql"));
      database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("0000_initial.sql");
      database.prepare("INSERT INTO d1_migrations (name) VALUES (NULL)").run();

      expect(() => database.exec(target.artifact)).toThrow(/CHECK constraint failed/);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials'").get())
        .toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("fails before target SQL when an existing migration ledger has the wrong schema", async () => {
    const apiRoot = fixtureRoot();
    const target = await prepareRemoteMigration({
      apiRoot,
      migration: "0001_auth_credentials.sql",
      predecessor: "0000_initial.sql",
    });
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE d1_migrations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`);
      database.exec(migrationSql("0000_initial.sql"));
      database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("0000_initial.sql");

      expect(() => database.exec(target.artifact)).toThrow(/CHECK constraint failed/);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials'").get())
        .toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("fails before target SQL when the ledger omits Wrangler's AUTOINCREMENT contract", async () => {
    const apiRoot = fixtureRoot();
    const target = await prepareRemoteMigration({
      apiRoot,
      migration: "0001_auth_credentials.sql",
      predecessor: "0000_initial.sql",
    });
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE d1_migrations(
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`);
      database.exec(migrationSql("0000_initial.sql"));
      database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("0000_initial.sql");

      expect(() => database.exec(target.artifact)).toThrow(/CHECK constraint failed/);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_credentials'").get())
        .toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rejects non-contiguous migration catalogs", async () => {
    const apiRoot = fixtureRoot();

    rmSync(join(apiRoot, "migrations", "0009_review_criteria_scoring.sql"));
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0011_generic_message_outbox.sql",
      predecessor: "0010_speaker_roster_ingest.sql",
    })).rejects.toThrow("Migration sequence is not contiguous");
  });

  it("rejects migrations that modify the ledger and refuses to overwrite an artifact", async () => {
    const apiRoot = fixtureRoot();
    const migrationPath = join(apiRoot, "migrations", "0011_generic_message_outbox.sql");
    writeFileSync(migrationPath, `${readFileSync(migrationPath, "utf8")}\nSELECT * FROM d1_migrations;\n`);
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0011_generic_message_outbox.sql",
      predecessor: "0010_speaker_roster_ingest.sql",
    })).rejects.toThrow("must not modify the Wrangler migration ledger");

    writeFileSync(migrationPath, migrationSql("0011_generic_message_outbox.sql"));
    await prepareRemoteMigration({
      apiRoot,
      migration: "0011_generic_message_outbox.sql",
      predecessor: "0010_speaker_roster_ingest.sql",
    });
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0011_generic_message_outbox.sql",
      predecessor: "0010_speaker_roster_ingest.sql",
    })).rejects.toThrow(/exist/i);
  });

  it("only writes artifacts beneath ignored operational directories", async () => {
    const apiRoot = fixtureRoot();
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0011_generic_message_outbox.sql",
      predecessor: "0010_speaker_roster_ingest.sql",
      output: "remote-migration.sql",
    })).rejects.toThrow("ignored .wrangler or .codex directory");
    await expect(prepareRemoteMigration({
      apiRoot,
      migration: "0011_generic_message_outbox.sql",
      predecessor: "0010_speaker_roster_ingest.sql",
      output: join(tmpdir(), "remote-migration.sql"),
    })).rejects.toThrow("relative path");
  });

  it("requires Git-ignore coverage and rejects a symlinked output root before writing", async () => {
    const unignoredApiRoot = fixtureRoot();
    rmSync(join(resolve(unignoredApiRoot, "../.."), ".gitignore"));
    await expect(prepareRemoteMigration({
      apiRoot: unignoredApiRoot,
      migration: "0008_workers_password_iterations.sql",
      predecessor: "0007_agenda_publication.sql",
    })).rejects.toThrow("must be ignored by Git");

    const linkedApiRoot = fixtureRoot();
    const outputRoot = join(linkedApiRoot, ".wrangler");
    const outside = join(resolve(linkedApiRoot, "../.."), "outside-output");
    mkdirSync(outside);
    symlinkSync(outside, outputRoot);
    await expect(prepareRemoteMigration({
      apiRoot: linkedApiRoot,
      migration: "0008_workers_password_iterations.sql",
      predecessor: "0007_agenda_publication.sql",
    })).rejects.toThrow("symbolic link");
    expect(existsSync(join(outside, "remote-migrations", "0008_workers_password_iterations.sql"))).toBe(false);

    const intermediateApiRoot = fixtureRoot();
    const intermediateOutputRoot = join(intermediateApiRoot, ".wrangler");
    const intermediateOutside = join(resolve(intermediateApiRoot, "../.."), "outside-intermediate-output");
    mkdirSync(intermediateOutputRoot);
    mkdirSync(intermediateOutside);
    symlinkSync(intermediateOutside, join(intermediateOutputRoot, "linked"));
    await expect(prepareRemoteMigration({
      apiRoot: intermediateApiRoot,
      migration: "0008_workers_password_iterations.sql",
      predecessor: "0007_agenda_publication.sql",
      output: ".wrangler/linked/created/0008_workers_password_iterations.sql",
    })).rejects.toThrow("symbolic link");
    expect(existsSync(join(intermediateOutside, "created"))).toBe(false);
  });

  it("distinguishes a missing Git checkout and missing Git executable from an unignored output", async () => {
    const archiveApiRoot = fixtureRoot({ initializeGit: false });
    await expect(prepareRemoteMigration({
      apiRoot: archiveApiRoot,
      migration: "0008_workers_password_iterations.sql",
      predecessor: "0007_agenda_publication.sql",
    })).rejects.toThrow("must be prepared from a Git checkout");

    const missingGitApiRoot = fixtureRoot();
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(prepareRemoteMigration({
        apiRoot: missingGitApiRoot,
        migration: "0008_workers_password_iterations.sql",
        predecessor: "0007_agenda_publication.sql",
      })).rejects.toThrow("Git is required to verify");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("accepts exactly one leading package-manager argument separator", async () => {
    const apiRoot = fixtureRoot();
    const messages = [];
    await runRemoteMigrationCli({
      apiRoot,
      argv: ["--", "--migration", "0008_workers_password_iterations.sql", "--predecessor", "0007_agenda_publication.sql"],
      log: (message) => messages.push(message),
    });

    expect(messages[0]).toBe("Prepared 0008_workers_password_iterations.sql after 0007_agenda_publication.sql.");
    await expect(runRemoteMigrationCli({
      apiRoot: fixtureRoot(),
      argv: ["--", "--", "--migration", "0008_workers_password_iterations.sql", "--predecessor", "0007_agenda_publication.sql"],
      log: () => {},
    })).rejects.toThrow("Unknown argument: --");
  });

  it("documents a later target failure as partial schema without a ledger append", async () => {
    const apiRoot = fixtureRoot();
    const migrationPath = join(apiRoot, "migrations", "0010_speaker_roster_ingest.sql");
    writeFileSync(migrationPath, `${migrationSql("0010_speaker_roster_ingest.sql")}\n
CREATE TABLE partial_migration_probe (id INTEGER PRIMARY KEY);\n
INSERT INTO missing_partial_migration_table (id) VALUES (1);\n`);
    const result = await prepareRemoteMigration({
      apiRoot,
      migration: "0010_speaker_roster_ingest.sql",
      predecessor: "0009_review_criteria_scoring.sql",
    });
    const database = databaseThroughPredecessor(migrationNames.indexOf("0010_speaker_roster_ingest.sql"));
    try {
      expect(() => database.exec(result.artifact)).toThrow();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_migration_probe'").get())
        .toEqual({ name: "partial_migration_probe" });
      expect(database.prepare("SELECT name FROM d1_migrations WHERE name = ?").get("0010_speaker_roster_ingest.sql"))
        .toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("applies every generated artifact through pinned Wrangler local D1", async () => {
    const apiRoot = fixtureRoot();
    const persistenceRoot = join(resolve(apiRoot, "../.."), "d1-state");
    const configPath = join(sourceApiRoot, "wrangler.jsonc");
    // Said plainly, because a missing binary would otherwise surface as an
    // opaque spawn failure 26 iterations into a three-minute suite.
    expect(existsSync(wranglerBin), `pinned Wrangler not found at ${wranglerBin}`).toBe(true);

    for (const [index, migration] of migrationNames.entries()) {
      const result = await prepareRemoteMigration({
        apiRoot,
        migration,
        predecessor: predecessorFor(index),
      });
      execFileSync(wranglerBin, [
        "d1", "execute", "confpilot-db", "--local",
        `--persist-to=${persistenceRoot}`,
        `--file=${join(apiRoot, result.output)}`,
        `--config=${configPath}`,
      ], { cwd: sourceApiRoot, stdio: "pipe" });
    }

    const certification = JSON.parse(execFileSync(wranglerBin, [
      "d1", "execute", "confpilot-db", "--local",
      `--persist-to=${persistenceRoot}`,
      "--command=SELECT name FROM d1_migrations ORDER BY id; PRAGMA foreign_key_check; PRAGMA quick_check;",
      "--json",
      `--config=${configPath}`,
    ], { cwd: sourceApiRoot, encoding: "utf8" }));

    expect(certification[0].results).toEqual(migrationNames.map((name) => ({ name })));
    expect(certification[1].results).toEqual([]);
    expect(certification[2].results).toEqual([{ quick_check: "ok" }]);

    /**
     * The one test here whose runtime grows with the schema, tripped on the
     * count rather than left to fail on the clock.
     *
     * One spawn per artifact is not an inefficiency to optimise away — it is the
     * operator procedure. `docs/operations/cloudflare-deployment.md` requires
     * artifacts be generated, applied and certified one at a time, and forbids
     * `d1 migrations apply` for this schema outright, because that path splits
     * compound trigger bodies and this schema has 192 triggers. Every faster
     * shape — one runner process, or concatenating the artifacts into a single
     * `--file` — stops the test mirroring the procedure it exists to prove, and
     * concatenation additionally leaks the `PRAGMA defer_foreign_keys` set by
     * `0004` and `0023` across artifacts that were never meant to see it.
     *
     * So the budget is spent, not saved: ~1.75s per artifact on CI, 180s of
     * timeout, which stops fitting somewhere past 100 migrations. Tripping at 60
     * leaves plenty of runway while making the decision a deliberate one taken
     * in daylight, rather than a timeout someone bisects on a Monday.
     */
    expect(
      migrationNames.length,
      "migration count is outgrowing this test's budget — read the comment above and choose, do not just raise the timeout",
    ).toBeLessThan(60);
    // Raised because this cost is irreducible, not because the test got slow. At
    // 60s it passed CI by 386ms, which is not a margin — it is a coin flip that
    // happened to keep landing the same way.
  }, 180_000);
});
