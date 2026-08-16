import { createHash, pbkdf2Sync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";
import { PASSWORD_ITERATIONS, constantTimeHexEqual } from "../src/password.ts";

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

  async all() {
    return { results: this.statement.all(...this.params), success: true, meta: {} };
  }

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
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database.prepare(query));
  }

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

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsUrl = new URL("../migrations/", import.meta.url);
  const migrationFiles = readdirSync(migrationsUrl)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of migrationFiles) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  database.exec(readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8"));
  return database;
}

function addCredential(
  database,
  userId = "usr-devflow-organizer",
  password = "correct horse battery staple",
) {
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex");
  database.prepare(`
    INSERT INTO user_credentials (
      user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
    ) VALUES (?, ?, ?, 'pbkdf2-sha256', ?, ?, ?)
  `).run(
    userId,
    salt.toString("hex"),
    hash,
    PASSWORD_ITERATIONS,
    "2026-08-11T00:00:00Z",
    "2026-08-11T00:00:00Z",
  );
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

describe("credential session and unsafe-request contracts", () => {
  let database;
  let env;

  beforeEach(() => {
    expect(PASSWORD_ITERATIONS).toBe(100_000);
    database = fixtureDatabase();
    addCredential(database);
    env = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: allowRateLimiter,
      LOGIN_ACCOUNT_RATE_LIMITER: allowRateLimiter,
    };
  });

  afterEach(() => database.close());

  it("rejects missing or cross-origin evidence before parsing a login", async () => {
    const app = createApp();
    const missing = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, env);
    const crossOrigin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { ...sameOriginHeaders, Origin: "https://attacker.invalid" },
      body: "{}",
    }, env);
    const missingCustomHeader = await app.request("/api/auth/login", {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries(sameOriginHeaders).filter(([name]) => name !== "X-ConfPilot-Request"),
      ),
      body: "{}",
    }, env);

    for (const response of [missing, crossOrigin, missingCustomHeader]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("UNSAFE_REQUEST_REJECTED");
    }
  });

  it("rejects malformed and invalid JSON with stable envelopes", async () => {
    const malformed = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: "{",
    }, env);
    const invalid = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ email: "not-an-email", password: "" }),
    }, env);

    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_JSON");
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("returns one response for an unknown user and a wrong password", async () => {
    const attempt = (email, password) => createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ email, password }),
    }, env);

    const unknown = await attempt("nobody@example.com", "wrong password value");
    const wrong = await attempt("organizer@devflow.example", "wrong password value");

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const unknownBody = await unknown.json();
    const wrongBody = await wrong.json();
    expect(unknownBody.error).toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "Email or password is incorrect.",
    });
    expect(wrongBody.error).toMatchObject({
      code: unknownBody.error.code,
      message: unknownBody.error.message,
    });
  });

  it("never exposes raw source or account identifiers as limiter keys", async () => {
    const keys = [];
    const captureLimiter = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    env.LOGIN_SOURCE_RATE_LIMITER = captureLimiter;
    env.LOGIN_ACCOUNT_RATE_LIMITER = captureLimiter;

    await createApp().request("/api/auth/login", {
      method: "POST",
      headers: { ...sameOriginHeaders, "CF-Connecting-IP": "203.0.113.42" },
      body: JSON.stringify({
        email: "nobody@example.com",
        password: "wrong password value",
      }),
    }, env);

    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(keys.join(" ")).not.toContain("203.0.113.42");
    expect(keys.join(" ")).not.toContain("nobody@example.com");
  });

  it("source-rate-limits before parsing or touching D1", async () => {
    env.LOGIN_SOURCE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    env.DB = {
      prepare: () => {
        throw new Error("database should not be touched");
      },
    };

    const response = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: "not-json",
    }, env);

    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("LOGIN_RATE_LIMITED");
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("account-rate-limits before credential lookup or PBKDF2", async () => {
    env.LOGIN_ACCOUNT_RATE_LIMITER = { limit: async () => ({ success: false }) };
    env.DB = {
      prepare: () => {
        throw new Error("database should not be touched");
      },
    };

    const response = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        email: "organizer@devflow.example",
        password: "wrong password value",
      }),
    }, env);

    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("LOGIN_RATE_LIMITED");
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("issues only a hashed server session in a hardened host cookie", async () => {
    const response = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        email: "  ORGANIZER@DEVFLOW.EXAMPLE ",
        password: "correct horse battery staple",
      }),
    }, env);
    const body = await response.json();
    const token = cookieToken(response);

    expect(response.status).toBe(200);
    expect(body.data.user).toEqual({
      id: "usr-devflow-organizer",
      email: "organizer@devflow.example",
      displayName: "Jordan Alvarez",
    });
    expect(body.data.memberships).toEqual([
      { eventSlug: "devflow-conf-2027", role: "organizer" },
    ]);
    expect(token).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("; Max-Age=604800");
    expect(response.headers.get("set-cookie")).toContain("; Path=/");
    expect(response.headers.get("set-cookie")).toContain("; HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("; Secure");
    expect(response.headers.get("set-cookie")).toContain("; SameSite=Strict");
    expect(response.headers.get("set-cookie")).toContain("; Priority=High");
    const stored = database.prepare(
      "SELECT token_hash AS tokenHash FROM auth_sessions ORDER BY created_at DESC LIMIT 1",
    ).get();
    expect(stored.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("returns the canonical session and rotates the current browser session for the same account", async () => {
    const first = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ email: "organizer@devflow.example", password: "correct horse battery staple" }),
    }, env);
    const firstToken = cookieToken(first);
    const second = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: { ...sameOriginHeaders, Cookie: `__Host-confpilot_session=${firstToken}` },
      body: JSON.stringify({ email: "organizer@devflow.example", password: "correct horse battery staple" }),
    }, env);
    const secondToken = cookieToken(second);

    expect(secondToken).not.toBe(firstToken);
    const oldSession = await createApp().request("/api/auth/session", {
      headers: { Cookie: `__Host-confpilot_session=${firstToken}` },
    }, env);
    const currentSession = await createApp().request("/api/auth/session", {
      headers: { Cookie: `__Host-confpilot_session=${secondToken}` },
    }, env);
    expect(oldSession.status).toBe(401);
    expect(currentSession.status).toBe(200);
    expect((await currentSession.json()).data.user.displayName).toBe("Jordan Alvarez");
  });

  it("revokes the displaced browser session when a different account signs in", async () => {
    const reviewerPassword = "reviewer correct horse battery staple";
    addCredential(database, "usr-devflow-reviewer", reviewerPassword);
    const first = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ email: "organizer@devflow.example", password: "correct horse battery staple" }),
    }, env);
    const firstToken = cookieToken(first);
    const second = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: { ...sameOriginHeaders, Cookie: `__Host-confpilot_session=${firstToken}` },
      body: JSON.stringify({ email: "reviewer@devflow.example", password: reviewerPassword }),
    }, env);
    const secondToken = cookieToken(second);

    expect(secondToken).not.toBe(firstToken);
    const displacedSession = await createApp().request("/api/auth/session", {
      headers: { Cookie: `__Host-confpilot_session=${firstToken}` },
    }, env);
    const currentSession = await createApp().request("/api/auth/session", {
      headers: { Cookie: `__Host-confpilot_session=${secondToken}` },
    }, env);
    expect(displacedSession.status).toBe(401);
    expect(currentSession.status).toBe(200);
    expect((await currentSession.json()).data.user).toMatchObject({
      id: "usr-devflow-reviewer",
      email: "reviewer@devflow.example",
      displayName: "Sam Whitfield",
    });
  });

  it("fails closed without account probing when stored password material is malformed", async () => {
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(
      "UPDATE user_credentials SET password_salt = ? WHERE user_id = ?",
    ).run("z".repeat(32), "usr-devflow-organizer");
    database.exec("PRAGMA ignore_check_constraints = OFF");

    const response = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        email: "organizer@devflow.example",
        password: "correct horse battery staple",
      }),
    }, env);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("fails closed without invoking an unsupported legacy work factor", async () => {
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.exec("DROP TRIGGER user_credentials_supported_material_update");
    database.prepare(
      "UPDATE user_credentials SET iterations = 600000 WHERE user_id = ?",
    ).run("usr-devflow-organizer");
    database.exec("PRAGMA ignore_check_constraints = OFF");

    const response = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        email: "organizer@devflow.example",
        password: "correct horse battery staple",
      }),
    }, env);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("compares canonical hexadecimal password material case-insensitively", () => {
    expect(constantTimeHexEqual("a1b2c3", "A1B2C3")).toBe(true);
    expect(constantTimeHexEqual("a1b2c3", "A1B2C4")).toBe(false);
  });

  it("revokes and clears the current session on idempotent logout", async () => {
    const login = await createApp().request("/api/auth/login", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ email: "organizer@devflow.example", password: "correct horse battery staple" }),
    }, env);
    const token = cookieToken(login);
    const logout = await createApp().request("/api/auth/logout", {
      method: "POST",
      headers: { ...sameOriginHeaders, Cookie: `__Host-confpilot_session=${token}` },
    }, env);
    const repeated = await createApp().request("/api/auth/logout", {
      method: "POST",
      headers: sameOriginHeaders,
    }, env);
    const after = await createApp().request("/api/auth/session", {
      headers: { Cookie: `__Host-confpilot_session=${token}` },
    }, env);

    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("__Host-confpilot_session=");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(repeated.status).toBe(204);
    expect(after.status).toBe(401);
  });

  it("applies unsafe-request protection to future API mutations", async () => {
    const rejected = await createApp().request("/api/future-write", { method: "POST" }, env);
    const protectedUnknown = await createApp().request("/api/future-write", {
      method: "POST",
      headers: sameOriginHeaders,
    }, env);

    expect(rejected.status).toBe(403);
    expect(protectedUnknown.status).toBe(404);
  });

  it("enforces normalized email uniqueness and bounded KDF work factors in D1", () => {
    expect(() => database.prepare(
      "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).run("duplicate-user", " ORGANIZER@DEVFLOW.EXAMPLE ", "Duplicate", "2026-08-11T00:00:00Z"))
      .toThrow(/UNIQUE constraint failed/);

    database.prepare(
      "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).run("weak-user", "weak@example.com", "Weak", "2026-08-11T00:00:00Z");
    expect(() => database.prepare(`
      INSERT INTO user_credentials (
        user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
      ) VALUES (?, ?, ?, 'pbkdf2-sha256', 1000, ?, ?)
    `).run(
      "weak-user",
      "00112233445566778899aabbccddeeff",
      "0".repeat(64),
      "2026-08-11T00:00:00Z",
      "2026-08-11T00:00:00Z",
    )).toThrow(/supported password work factor/);

    expect(() => database.prepare(`
      INSERT INTO user_credentials (
        user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
      ) VALUES (?, ?, ?, 'pbkdf2-sha256', 800000, ?, ?)
    `).run(
      "weak-user",
      "00112233445566778899aabbccddeeff",
      "0".repeat(64),
      "2026-08-11T00:00:00Z",
      "2026-08-11T00:00:00Z",
    )).toThrow(/supported password work factor/);
  });

  it("detects normalized-email collisions before migration 0001", () => {
    const preflightDatabase = new DatabaseSync(":memory:");
    preflightDatabase.exec("PRAGMA foreign_keys = ON");
    preflightDatabase.exec(readFileSync(new URL("../migrations/0000_initial.sql", import.meta.url), "utf8"));
    preflightDatabase.prepare(
      "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "usr-devflow-organizer",
      "organizer@devflow.example",
      "Jordan Alvarez",
      "2026-08-10T00:00:00Z",
    );
    preflightDatabase.prepare(
      "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "collision-user",
      " ORGANIZER@DEVFLOW.EXAMPLE ",
      "Collision",
      "2026-08-11T00:00:00Z",
    );

    const collisions = preflightDatabase.prepare(
      readFileSync(new URL("../preflight/preflight_auth_credentials.sql", import.meta.url), "utf8"),
    ).all();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      normalized_email: "organizer@devflow.example",
      collision_count: 2,
    });
    expect(collisions[0].user_ids.split(",").sort()).toEqual([
      "collision-user",
      "usr-devflow-organizer",
    ]);
    preflightDatabase.close();
  });

  it("preserves legacy credentials while accepting only the supported or legacy factors", () => {
    const upgradeDatabase = new DatabaseSync(":memory:");
    try {
      upgradeDatabase.exec("PRAGMA foreign_keys = ON");
      const migrationNames = readdirSync(new URL("../migrations/", import.meta.url))
        .filter((name) => /^000[0-7]_[a-z0-9_]+\.sql$/.test(name))
        .sort();
      for (const name of migrationNames) {
        upgradeDatabase.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      upgradeDatabase.prepare(
        "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
      ).run("legacy-user", "legacy@example.com", "Legacy User", "2026-08-11T00:00:00Z");
      upgradeDatabase.prepare(`
        INSERT INTO user_credentials (
          user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
        ) VALUES (?, ?, ?, 'pbkdf2-sha256', 600000, ?, ?)
      `).run(
        "legacy-user",
        "00112233445566778899aabbccddeeff",
        "0".repeat(64),
        "2026-08-11T00:00:00Z",
        "2026-08-11T00:00:00Z",
      );

      upgradeDatabase.exec(readFileSync(
        new URL("../migrations/0008_workers_password_iterations.sql", import.meta.url),
        "utf8",
      ));

      expect(upgradeDatabase.prepare(
        "SELECT iterations FROM user_credentials WHERE user_id = ?",
      ).get("legacy-user").iterations).toBe(600_000);
      expect(upgradeDatabase.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      upgradeDatabase.prepare(
        "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
      ).run("new-legacy-user", "new-legacy@example.com", "New Legacy User", "2026-08-12T00:00:00Z");
      expect(() => upgradeDatabase.prepare(`
        INSERT INTO user_credentials (
          user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
        ) VALUES (?, ?, ?, 'pbkdf2-sha256', 600000, ?, ?)
      `).run(
        "new-legacy-user",
        "11223344556677889900aabbccddeeff",
        "1".repeat(64),
        "2026-08-12T00:00:00Z",
        "2026-08-12T00:00:00Z",
      )).toThrow(/supported password work factor/);
      expect(() => upgradeDatabase.prepare(`
        UPDATE user_credentials SET iterations = 200000 WHERE user_id = ?
      `).run("legacy-user")).toThrow(/supported password work factor/);
      expect(() => upgradeDatabase.prepare(`
        UPDATE user_credentials SET iterations = 100000 WHERE user_id = ?
      `).run("legacy-user")).toThrow(/new salt and hash/);
      expect(() => upgradeDatabase.prepare(`
        UPDATE user_credentials
        SET password_salt = ?, password_hash = ?, iterations = 100000, updated_at = ?
        WHERE user_id = ?
      `).run(
        "11223344556677889900aabbccddeeff",
        "1".repeat(64),
        "2026-08-12T00:00:00Z",
        "legacy-user",
      )).not.toThrow();
      expect(upgradeDatabase.prepare(`
        SELECT password_salt AS passwordSalt, password_hash AS passwordHash,
          iterations, updated_at AS updatedAt
        FROM user_credentials WHERE user_id = ?
      `).get("legacy-user")).toEqual({
        passwordSalt: "11223344556677889900aabbccddeeff",
        passwordHash: "1".repeat(64),
        iterations: 100_000,
        updatedAt: "2026-08-12T00:00:00Z",
      });
    } finally {
      upgradeDatabase.close();
    }
  });
});
