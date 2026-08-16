import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";

class D1Statement {
  constructor(statement, read, additionalChanges = 0, onBind = null) {
    this.statement = statement;
    this.read = read;
    this.additionalChanges = additionalChanges;
    this.onBind = onBind;
    this.params = [];
  }
  bind(...params) {
    this.onBind?.(params);
    const bound = new D1Statement(this.statement, this.read, this.additionalChanges, this.onBind);
    bound.params = params;
    return bound;
  }
  async first(column) {
    const row = this.statement.get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
  async run() {
    const result = this.statement.run(...this.params);
    return { results: [], success: true, meta: { changes: Number(result.changes) + this.additionalChanges } };
  }
  async execute() { return this.read ? this.all() : this.run(); }
}

class D1DatabaseFake {
  constructor(database) {
    this.database = database;
    this.countTriggerWrites = false;
    this.rejectUnscopedSpeakerReads = false;
    this.rosterLookupQueries = 0;
    this.maxRosterLookupBindings = 0;
  }
  prepare(query) {
    if (this.rejectUnscopedSpeakerReads
      && (query.includes("FROM speakers WHERE event_id = ? ORDER BY name")
        || query.includes("FROM speaker_content_history history"))) {
      throw new Error("speaker workspace attempted an unscoped event read");
    }
    const hasTriggerSideWrite = /^\s*INSERT\s+INTO\s+(deliverable_versions|content_reviews|speaker_tasks)\b/i.test(query)
      || /^\s*UPDATE\s+(speakers|speaker_tasks|deliverable_requests)\b/i.test(query);
    const additionalChanges = this.countTriggerWrites && hasTriggerSideWrite
      ? 1
      : 0;
    const rosterLookup = query.includes("AS normalizedEmail") && query.includes(" IN (");
    if (rosterLookup) this.rosterLookupQueries += 1;
    return new D1Statement(
      this.database.prepare(query),
      /^\s*(SELECT|WITH|PRAGMA)\b/i.test(query),
      additionalChanges,
      rosterLookup ? (params) => {
        this.maxRosterLookupBindings = Math.max(this.maxRosterLookupBindings, params.length);
      } : null,
    );
  }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class R2BucketFake {
  objects = new Map();
  deleted = [];
  activeStreams = 0;
  maxActiveStreams = 0;
  mutateMetadataOnGetKey = null;
  async put(key, value, options) {
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
    this.objects.set(key, {
      bytes,
      size: bytes.byteLength,
      httpMetadata: structuredClone(options.httpMetadata),
      customMetadata: structuredClone(options.customMetadata),
      checksums: { sha256: options.sha256.slice(0) },
    });
    // Reports what landed, as the port requires — a double returning less than
    // its own head() is the divergence this contract exists to catch.
    return this.head(key);
  }
  async head(key) {
    const value = this.objects.get(key);
    return value ? { ...value, body: undefined } : null;
  }
  async get(key) {
    const value = this.objects.get(key);
    if (!value) return null;
    if (key === this.mutateMetadataOnGetKey) {
      value.customMetadata = { ...value.customMetadata, eventScope: "evt-fieldnotes" };
    }
    const chunks = [value.bytes.slice(0, Math.ceil(value.bytes.byteLength / 2)), value.bytes.slice(Math.ceil(value.bytes.byteLength / 2))]
      .filter((chunk) => chunk.byteLength > 0);
    let index = 0;
    let active = false;
    const body = new ReadableStream({
      pull: (controller) => {
        if (!active) {
          active = true;
          this.activeStreams += 1;
          this.maxActiveStreams = Math.max(this.maxActiveStreams, this.activeStreams);
        }
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else {
          this.activeStreams -= 1;
          controller.close();
        }
      },
      cancel: () => {
        if (active && index <= chunks.length) this.activeStreams -= 1;
      },
    });
    return { ...value, body };
  }
  async delete(key) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

function insertDeliverable(database, {
  eventId = "evt-devflow",
  sessionId = "ses-d-2",
  speakerId = "spk-d-priya",
  organizerId = "usr-devflow-organizer",
  id,
  requestId,
  requestKey,
  requestLabel,
  versionNumber = 1,
  filename,
  objectKey,
  bytes,
  outcome = "approved",
  reviewedAt = "2027-04-20T17:00:00Z",
}) {
  database.prepare(`INSERT OR IGNORE INTO deliverable_requests (
    id, event_id, program_session_id, request_key, request_type, label, instructions,
    due_at, allowed_content_types_json, max_bytes, required, active, revision,
    created_by_user_id, updated_by_user_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'presentation', ?, '', '2027-04-01T17:00:00Z',
    '["application/pdf"]', 10485760, 0, 1, 1, ?, ?,
    '2027-03-01T17:00:00Z', '2027-03-01T17:00:00Z')`).run(
    requestId, eventId, sessionId, requestKey, requestLabel, organizerId, organizerId,
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  database.prepare(`INSERT INTO deliverable_versions (
    id, event_id, request_id, program_session_id, uploaded_by_speaker_id,
    version_number, idempotency_key, original_filename, object_key, content_type,
    byte_size, sha256, note, uploaded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?, '', ?)`).run(
    id, eventId, requestId, sessionId, speakerId, versionNumber,
    `archive-${id}`, filename, objectKey, bytes.byteLength, sha256, reviewedAt,
  );
  database.prepare(`INSERT INTO content_reviews (
    id, event_id, program_session_id, version_id, idempotency_key,
    outcome, comment, reviewed_by_user_id, reviewed_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'Archive fixture review.', ?, ?)`).run(
    `review-${id}`, eventId, sessionId, id, `review-${id}`, outcome, organizerId, reviewedAt,
  );
  return { eventId, objectKey, originalFilename: filename, contentType: "application/pdf", byteSize: bytes.byteLength, sha256 };
}

async function putDeliverable(bucket, row, bytes) {
  await bucket.put(row.objectKey, bytes, {
    httpMetadata: { contentType: row.contentType },
    customMetadata: {
      eventScope: row.eventId,
      originalFilename: row.originalFilename,
      sha256: row.sha256,
    },
    sha256: Uint8Array.from(Buffer.from(row.sha256, "hex")).buffer,
  });
}

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("Missing ZIP end record");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const output = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Missing ZIP central record");
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    output.push({ name, body: bytes.slice(dataOffset, dataOffset + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return output;
}

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  database.exec(readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8"));
  return database;
}

function addSession(database, userId, token) {
  database.prepare(`INSERT INTO auth_sessions
    (id, user_id, token_hash, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, '2026-08-11T00:00:00Z')`).run(
    `auth-${token}`, userId, createHash("sha256").update(token).digest("hex"),
  );
  return `__Host-confpilot_session=${token}`;
}

function api(env, path, { method = "GET", cookie, json, form, headers = {} } = {}) {
  return createApp().request(`https://confpilot.test/api${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "GET" ? {} : {
        Origin: "https://confpilot.test",
        "Sec-Fetch-Site": "same-origin",
        "X-ConfPilot-Request": "1",
      }),
      ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(form === undefined ? {} : { body: form }),
  }, env);
}

const profileInput = (profile, changes = {}) => ({
  name: profile.name,
  contactEmail: profile.contactEmail,
  title: profile.title,
  company: profile.company,
  bio: profile.bio,
  socialUrls: profile.socialUrls,
  travelPreferences: profile.travelPreferences,
  publicVisibility: profile.publicVisibility,
  revision: profile.revision,
  ...changes,
});

const ownedProfileInput = (profile, changes = {}) => ({
  name: profile.name,
  contactEmail: profile.contactEmail,
  title: profile.title,
  company: profile.company,
  bio: profile.bio,
  socialUrls: profile.socialUrls,
  travelPreferences: profile.travelPreferences,
  revision: profile.revision,
  ...changes,
});

describe("live speaker content API", () => {
  let database;
  let bucket;
  let env;
  let organizer;
  let reviewer;
  let priya;
  let marcus;
  let elena;

  beforeEach(() => {
    database = fixtureDatabase();
    bucket = new R2BucketFake();
    env = { DB: new D1DatabaseFake(database), FILES: bucket };
    organizer = addSession(database, "usr-devflow-organizer", "organizer-content");
    reviewer = addSession(database, "usr-devflow-reviewer", "reviewer-content");
    priya = addSession(database, "usr-d-priya", "priya-content");
    marcus = addSession(database, "usr-d-marcus", "marcus-content");
    elena = addSession(database, "usr-d-elena", "elena-content");
  });

  afterEach(() => database.close());

  it("creates an event-scoped roster from non-seed records", async () => {
    database.prepare(`INSERT INTO events (
      id, slug, name, tagline, location, description, starts_on, ends_on,
      cfp_deadline, status, time_zone
    ) VALUES (?, ?, ?, '', '', '', '2028-01-01', '2028-01-02', ?, 'draft', 'UTC')`)
      .run("evt-roster-test", "roster-test-2028", "Roster Test 2028", "2027-12-01T00:00:00Z");
    database.prepare(`INSERT INTO event_memberships (
      id, event_id, user_id, role, created_at
    ) VALUES (?, ?, ?, 'organizer', ?)`)
      .run("mem-roster-test", "evt-roster-test", "usr-devflow-organizer", "2026-08-11T00:00:00Z");

    const created = await api(env, "/events/roster-test-2028/speakers", {
      method: "POST", cookie: organizer,
      json: { name: "Non Seed Speaker", email: "non-seed@example.test", title: "", company: "", bio: "" },
    });
    expect((await created.json()).data.summary.created).toBe(1);
    const roster = await api(env, "/events/roster-test-2028/speakers", { cookie: organizer });
    expect((await roster.json()).data.speakers).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ?")
      .get("evt-devflow").count).toBeGreaterThan(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ?")
      .get("evt-roster-test").count).toBe(1);
  });

  it("keeps the speaker workspace owner-scoped and supports semantic profile/task retries", async () => {
    env.DB.rejectUnscopedSpeakerReads = true;
    const workspaceResponse = await api(env, "/events/devflow-conf-2027/speaker/content-workspace", { cookie: priya });
    env.DB.rejectUnscopedSpeakerReads = false;
    expect(workspaceResponse.status).toBe(200);
    const workspace = (await workspaceResponse.json()).data;
    expect(workspace.speaker.id).toBe("spk-d-priya");
    expect(workspace.sessions.flatMap((session) => session.tasks).every((task) =>
      database.prepare("SELECT speaker_id AS speakerId FROM speaker_tasks WHERE id = ?").get(task.id).speakerId === "spk-d-priya"))
      .toBe(true);
    expect(JSON.stringify(workspace)).not.toContain("spk-d-marcus\",\"taskKey");

    const update = ownedProfileInput(workspace.speaker, { bio: `${workspace.speaker.bio} Updated.` });
    const first = await api(env, "/events/devflow-conf-2027/speaker/profile", { method: "PATCH", cookie: priya, json: update });
    expect(first.status).toBe(200);
    expect((await first.clone().json()).data).toMatchObject({
      headshot: null,
      publicVisibility: workspace.speaker.publicVisibility,
    });
    const retry = await api(env, "/events/devflow-conf-2027/speaker/profile", { method: "PATCH", cookie: priya, json: update });
    expect(retry.status).toBe(200);
    expect((await retry.json()).data.revision).toBe((await first.json()).data.revision);
    const roster = (await (await api(env, "/events/devflow-conf-2027/speakers", { cookie: organizer })).json()).data;
    const ownerSnapshot = roster.speakers.find((value) => value.profile.id === "spk-d-priya").history
      .find((value) => value.action === "updated");
    expect(ownerSnapshot.profile.bio).toBe(workspace.speaker.bio);
    expect((await api(env, `/events/devflow-conf-2027/speakers/spk-d-priya/history/${ownerSnapshot.id}/restore`, {
      method: "POST", cookie: organizer,
    })).status).toBe(200);

    const ownTask = workspace.sessions.find((session) => session.id === "ses-d-2").tasks[0];
    expect((await api(env, `/events/devflow-conf-2027/speaker/tasks/${ownTask.id}`, {
      method: "PATCH", cookie: priya, json: { state: "complete", revision: ownTask.revision },
    })).status).toBe(200);
    expect((await api(env, "/events/devflow-conf-2027/speaker/tasks/task:presenter-d-2-marcus:confirm", {
      method: "PATCH", cookie: priya, json: { state: "complete", revision: 1 },
    })).status).toBe(404);

    const waivedTask = workspace.sessions.find((session) => session.id === "ses-d-2").tasks[1];
    const waived = await api(env, `/events/devflow-conf-2027/speakers/spk-d-priya/tasks/${waivedTask.id}`, {
      method: "PATCH", cookie: organizer, json: { state: "waived", revision: waivedTask.revision },
    });
    expect(waived.status).toBe(200);
    const blockedTask = await api(env, `/events/devflow-conf-2027/speaker/tasks/${waivedTask.id}`, {
      method: "PATCH", cookie: priya,
      json: { state: "complete", revision: (await waived.json()).data.revision },
    });
    expect(blockedTask.status).toBe(409);
    expect((await blockedTask.json()).error.code).toBe("TASK_WAIVED");

    const deadlineTask = workspace.sessions.find((session) => session.id === "ses-d-2").tasks
      .find((task) => task.taskKey === "profile");
    const deadline = await api(env, `/events/devflow-conf-2027/speakers/spk-d-priya/tasks/${deadlineTask.id}`, {
      method: "PATCH",
      cookie: organizer,
      json: { state: "open", dueAt: "2027-04-01T17:00:00Z", revision: deadlineTask.revision },
    });
    expect(deadline.status).toBe(200);
    expect((await deadline.json()).data).toMatchObject({ state: "open", dueAt: "2027-04-01T17:00:00Z" });
  });

  it("projects one speaker's portal onboarding changes into the organizer roster", async () => {
    const taskResponse = await api(env, "/events/devflow-conf-2027/speakers/tasks", {
      method: "POST",
      cookie: organizer,
      json: {
        targets: [{ speakerId: "spk-d-priya", sessionId: "ses-d-2" }],
        taskKey: "roundtrip-confirmation",
        label: "Confirm roundtrip readiness",
        dueAt: "2027-04-01T17:00:00Z",
      },
    });
    expect(taskResponse.status).toBe(200);

    let workspace = (await (await api(
      env,
      "/events/devflow-conf-2027/speaker/content-workspace",
      { cookie: priya },
    )).json()).data;
    const bio = `${workspace.speaker.bio} Portal roundtrip verified.`;
    const profileResponse = await api(env, "/events/devflow-conf-2027/speaker/profile", {
      method: "PATCH",
      cookie: priya,
      json: ownedProfileInput(workspace.speaker, { bio }),
    });
    expect(profileResponse.status).toBe(200);

    const headshot = new FormData();
    headshot.set("file", new File([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    ], "priya-roundtrip.png", { type: "image/png" }));
    const headshotResponse = await api(env, "/events/devflow-conf-2027/speaker/headshot", {
      method: "POST",
      cookie: priya,
      form: headshot,
    });
    expect(headshotResponse.status).toBe(200);

    workspace = (await (await api(
      env,
      "/events/devflow-conf-2027/speaker/content-workspace",
      { cookie: priya },
    )).json()).data;
    const task = workspace.sessions.flatMap((session) => session.tasks)
      .find((candidate) => candidate.taskKey === "roundtrip-confirmation");
    expect(task).toMatchObject({
      label: "Confirm roundtrip readiness",
      state: "open",
      dueAt: "2027-04-01T17:00:00Z",
    });
    const completed = await api(env, `/events/devflow-conf-2027/speaker/tasks/${task.id}`, {
      method: "PATCH",
      cookie: priya,
      json: { state: "complete", revision: task.revision },
    });
    expect(completed.status).toBe(200);

    const roster = (await (await api(
      env,
      "/events/devflow-conf-2027/speakers",
      { cookie: organizer },
    )).json()).data;
    const organizerView = roster.speakers.find((candidate) => candidate.profile.id === "spk-d-priya");
    expect(organizerView.profile).toMatchObject({
      bio,
      headshot: {
        originalFilename: "priya-roundtrip.png",
        contentType: "image/png",
        viewPath: "/api/events/devflow-conf-2027/speakers/spk-d-priya/headshot/file",
      },
    });
    expect(organizerView.profile.headshot.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(organizerView.readiness.headshotReady).toBe(true);
    expect(organizerView.tasks.find((candidate) => candidate.taskKey === "roundtrip-confirmation"))
      .toMatchObject({ state: "complete", dueAt: "2027-04-01T17:00:00Z" });
    const privateHeadshot = await api(env, organizerView.profile.headshot.viewPath.replace("/api", ""), {
      cookie: organizer,
    });
    expect(privateHeadshot.status).toBe(200);
    expect(new Uint8Array(await privateHeadshot.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    );
  });

  it("uses one deterministic validator and dedupe path for manual and CSV roster intake", async () => {
    const manual = await api(env, "/events/devflow-conf-2027/speakers", {
      method: "POST",
      cookie: organizer,
      json: { name: "  Zoë Rivera  ", email: "  ZOE@EXAMPLE.TEST ", title: "SRE", company: "", bio: "" },
    });
    expect(manual.status).toBe(200);
    expect((await manual.json()).data).toMatchObject({
      summary: { created: 1, duplicate: 0, invalid: 0, conflict: 0, failed: 0 },
      rows: [{ rowNumber: 1, status: "created", code: "CREATED", normalizedEmail: "zoe@example.test" }],
    });

    const csvText = "name,email,title,company,bio\n"
      + "Zoë Rivera,ZOE@example.test,SRE,,duplicate\n"
      + "李 明,li.ming@example.test,Engineer,Example,Unicode name\n"
      + "Missing email,,Engineer,,\n"
      + "Bad address,not-an-email,Engineer,,\n"
      + "Malformed,malformed@example.test,Engineer\n";
    const csv = new FormData();
    csv.set("file", new File([csvText], "speakers.csv", { type: "text/csv" }));
    const imported = await api(env, "/events/devflow-conf-2027/speakers/import", {
      method: "POST", cookie: organizer, form: csv,
    });
    expect(imported.status).toBe(200);
    expect((await imported.json()).data).toMatchObject({
      summary: { created: 1, duplicate: 1, invalid: 3, conflict: 0, failed: 0 },
      rows: [
        { rowNumber: 2, status: "duplicate", code: "DUPLICATE_EMAIL", normalizedEmail: "zoe@example.test" },
        { rowNumber: 3, status: "created", code: "CREATED", normalizedEmail: "li.ming@example.test" },
        { rowNumber: 4, status: "invalid", code: "VALIDATION_FAILED", normalizedEmail: null },
        { rowNumber: 5, status: "invalid", code: "VALIDATION_FAILED", normalizedEmail: null },
        { rowNumber: 6, status: "invalid", code: "MALFORMED_CSV", normalizedEmail: null },
      ],
    });
    const repeatedCsv = new FormData();
    repeatedCsv.set("file", new File([csvText], "speakers.csv", { type: "text/csv" }));
    const reimported = await api(env, "/events/devflow-conf-2027/speakers/import", {
      method: "POST", cookie: organizer, form: repeatedCsv,
    });
    expect((await reimported.json()).data.summary).toEqual({ created: 0, duplicate: 2, invalid: 3, conflict: 0, failed: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND lower(trim(contact_email)) IN (?, ?)")
      .get("evt-devflow", "zoe@example.test", "li.ming@example.test").count).toBe(2);
  });

  it("fails closed when a roster email already belongs to an account without an event speaker", async () => {
    database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("usr-import-safe", "safe@example.test", "Existing Account Name", "2026-08-11T00:00:00Z");
    database.prepare(`INSERT INTO user_credentials (
      user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at
    ) VALUES (?, ?, ?, 'pbkdf2-sha256', 100000, ?, ?)`).run(
      "usr-import-safe", "a".repeat(32), "b".repeat(64),
      "2026-08-11T00:00:00Z", "2026-08-11T00:00:00Z",
    );
    const credentialBefore = database.prepare(
      "SELECT password_salt AS salt, password_hash AS hash, iterations FROM user_credentials WHERE user_id = ?",
    ).get("usr-import-safe");
    const blocked = await api(env, "/events/devflow-conf-2027/speakers", {
      method: "POST", cookie: organizer,
      json: { name: "Roster Name", email: "SAFE@example.test", title: "", company: "", bio: "" },
    });
    expect(blocked.status).toBe(200);
    expect((await blocked.json()).data).toMatchObject({
      summary: { created: 0, duplicate: 0, invalid: 0, conflict: 1, failed: 0 },
      rows: [{
        status: "conflict",
        code: "ACCOUNT_ROLE_CONFLICT",
        message: "An account already uses this email. No speaker profile was created because roster import cannot verify account ownership.",
        normalizedEmail: "safe@example.test",
        speakerId: null,
        linkedAccount: false,
      }],
    });
    expect(database.prepare("SELECT display_name AS name FROM users WHERE id = ?").get("usr-import-safe").name)
      .toBe("Existing Account Name");
    expect(database.prepare(
      "SELECT password_salt AS salt, password_hash AS hash, iterations FROM user_credentials WHERE user_id = ?",
    ).get("usr-import-safe")).toEqual(credentialBefore);
    expect(database.prepare("SELECT COUNT(*) AS count FROM event_memberships WHERE event_id = ? AND user_id = ?")
      .get("evt-devflow", "usr-import-safe").count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND contact_email = ?")
      .get("evt-devflow", "safe@example.test").count).toBe(0);

    database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("usr-import-conflict", "conflict@example.test", "Reviewer Account", "2026-08-11T00:00:00Z");
    database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'reviewer', ?)")
      .run("mem-import-conflict", "evt-devflow", "usr-import-conflict", "2026-08-11T00:00:00Z");
    const conflict = await api(env, "/events/devflow-conf-2027/speakers", {
      method: "POST", cookie: organizer,
      json: { name: "Should Not Link", email: "conflict@example.test", title: "", company: "", bio: "" },
    });
    expect((await conflict.json()).data).toMatchObject({
      summary: { created: 0, duplicate: 0, invalid: 0, conflict: 1, failed: 0 },
      rows: [{ status: "conflict", code: "ACCOUNT_ROLE_CONFLICT", linkedAccount: false }],
    });
    expect(database.prepare("SELECT role FROM event_memberships WHERE id = ?").get("mem-import-conflict").role)
      .toBe("reviewer");
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND contact_email = ?")
      .get("evt-devflow", "conflict@example.test").count).toBe(0);

    const existingSpeaker = await api(env, "/events/devflow-conf-2027/speakers", {
      method: "POST", cookie: organizer,
      json: { name: "Duplicate Priya", email: "PRIYA@DEVFLOW.EXAMPLE", title: "", company: "", bio: "" },
    });
    expect((await existingSpeaker.json()).data).toMatchObject({
      summary: { created: 0, duplicate: 1, invalid: 0, conflict: 0, failed: 0 },
      rows: [{
        status: "duplicate",
        code: "DUPLICATE_EMAIL",
        speakerId: "spk-d-priya",
        linkedAccount: true,
      }],
    });
  });

  it("chunks roster identity lookups below the D1 parameter limit", async () => {
    const rows = Array.from({ length: 120 }, (_, index) =>
      `Speaker ${index + 1},batch-${index + 1}@example.test,,,`).join("\n");
    const csv = new FormData();
    csv.set("file", new File([
      `name,email,title,company,bio\n${rows}\n`,
    ], "speakers.csv", { type: "text/csv" }));

    const response = await api(env, "/events/devflow-conf-2027/speakers/import", {
      method: "POST", cookie: organizer, form: csv,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data.summary).toEqual({
      created: 120, duplicate: 0, invalid: 0, conflict: 0, failed: 0,
    });
    expect(env.DB.rosterLookupQueries).toBe(4);
    expect(env.DB.maxRosterLookupBindings).toBeLessThanOrEqual(91);
  });

  it("does not create a dead-end roster profile for a matching cross-event account", async () => {
    database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("usr-cross-event", "cross-event@example.test", "Cross Event Account", "2026-08-11T00:00:00Z");
    database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'reviewer', ?)")
      .run("mem-cross-event-reviewer", "evt-fieldnotes", "usr-cross-event", "2026-08-11T00:00:00Z");

    const blocked = await api(env, "/events/devflow-conf-2027/speakers", {
      method: "POST", cookie: organizer,
      json: { name: "Cross Event Speaker", email: "CROSS-EVENT@example.test", title: "", company: "", bio: "" },
    });

    expect(blocked.status).toBe(200);
    expect((await blocked.json()).data.rows[0]).toMatchObject({
      status: "conflict", code: "ACCOUNT_ROLE_CONFLICT", linkedAccount: false,
    });
    expect(database.prepare("SELECT event_id AS eventId, role FROM event_memberships WHERE user_id = ? ORDER BY event_id")
      .all("usr-cross-event")).toEqual([
      { eventId: "evt-fieldnotes", role: "reviewer" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND contact_email = ?")
      .get("evt-devflow", "cross-event@example.test").count).toBe(0);
  });

  it("enforces normalized event-scoped roster identity in SQLite", () => {
    expect(() => database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, 'evt-devflow', NULL, ?, ?, '', '', '', ?, NULL, 'DL', 'incomplete', 'missing', 'private')`)
      .run("spk-normalized-source", "normalized-source", "Normalized Source", " Direct-Link@Example.Test "))
      .not.toThrow();

    expect(() => database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, 'evt-devflow', NULL, ?, ?, '', '', '', ?, NULL, 'DU', 'incomplete', 'missing', 'private')`)
      .run("spk-normalized-duplicate", "normalized-duplicate", "Duplicate", "direct-link@example.test"))
      .toThrow(/UNIQUE constraint failed/i);
    expect(() => database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, 'evt-fieldnotes', NULL, ?, ?, '', '', '', ?, NULL, 'CE', 'incomplete', 'missing', 'private')`)
      .run("spk-other-event-email", "other-event-email", "Other Event", "direct-link@example.test"))
      .not.toThrow();

  });

  it("reports a failed roster row and continues without leaving that speaker behind", async () => {
    database.exec(`CREATE TRIGGER reject_roster_rollback
      BEFORE INSERT ON speakers
      WHEN NEW.contact_email = 'rollback@example.test'
      BEGIN SELECT RAISE(ABORT, 'forced speaker insert failure'); END`);

    const csv = new FormData();
    csv.set("file", new File([
      "name,email,title,company,bio\n"
      + "Before Failure,before-failure@example.test,,,\n"
      + "Rollback Speaker,rollback@example.test,,,\n"
      + "After Failure,after-failure@example.test,,,\n",
    ], "speakers.csv", { type: "text/csv" }));
    const response = await api(env, "/events/devflow-conf-2027/speakers/import", {
      method: "POST", cookie: organizer, form: csv,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      summary: { created: 2, duplicate: 0, invalid: 0, conflict: 0, failed: 1 },
      rows: [
        { rowNumber: 2, status: "created", code: "CREATED" },
        { rowNumber: 3, status: "failed", code: "CREATE_FAILED", speakerId: null },
        { rowNumber: 4, status: "created", code: "CREATED" },
      ],
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND contact_email = ?")
      .get("evt-devflow", "rollback@example.test").count).toBe(0);
    expect(database.prepare(`SELECT contact_email AS email FROM speakers
      WHERE event_id = ? AND contact_email IN (?, ?) ORDER BY contact_email`)
      .all("evt-devflow", "before-failure@example.test", "after-failure@example.test"))
      .toEqual([{ email: "after-failure@example.test" }, { email: "before-failure@example.test" }]);
  });

  it("rejects non-CSV and oversized roster uploads before ingestion", async () => {
    const wrongType = new FormData();
    wrongType.set("file", new File(["name,email\nA,a@example.test"], "speakers.txt", { type: "text/plain" }));
    const wrongTypeResponse = await api(env, "/events/devflow-conf-2027/speakers/import", {
      method: "POST", cookie: organizer, form: wrongType,
    });
    expect(wrongTypeResponse.status).toBe(400);
    expect((await wrongTypeResponse.json()).error.code).toBe("CSV_REQUIRED");

    const oversized = new FormData();
    oversized.set("file", new File([new Uint8Array(512 * 1024 + 1)], "speakers.csv", { type: "text/csv" }));
    const oversizedResponse = await api(env, "/events/devflow-conf-2027/speakers/import", {
      method: "POST", cookie: organizer, form: oversized,
    });
    expect(oversizedResponse.status).toBe(413);
    expect((await oversizedResponse.json()).error.code).toBe("CSV_TOO_LARGE");
  });

  it("derives speaker agreement readiness from the release task", async () => {
    database.prepare(`UPDATE speaker_tasks SET state = 'open', completed_at = NULL,
      revision = revision + 1, updated_at = '2027-02-21T00:00:00Z'
      WHERE event_id = 'evt-devflow' AND speaker_id = 'spk-d-priya' AND task_key = 'release'`).run();
    database.prepare(`UPDATE speakers SET agreement_status = 'missing', revision = revision + 1,
      updated_at = '2027-02-21T00:00:01Z'
      WHERE event_id = 'evt-devflow' AND id = 'spk-d-priya'`).run();

    let workspace = (await (await api(env, "/events/devflow-conf-2027/speaker/content-workspace", {
      cookie: priya,
    })).json()).data;
    const releaseTask = workspace.sessions.flatMap((session) => session.tasks)
      .find((task) => task.taskKey === "release");
    const completed = await api(env, `/events/devflow-conf-2027/speaker/tasks/${releaseTask.id}`, {
      method: "PATCH", cookie: priya,
      json: { state: "complete", revision: releaseTask.revision },
    });
    expect(completed.status).toBe(200);
    expect(database.prepare("SELECT agreement_status AS status FROM speakers WHERE id = 'spk-d-priya'").get().status)
      .toBe("signed");

    const canonicalTask = (await completed.json()).data;
    const reopened = await api(env, `/events/devflow-conf-2027/speaker/tasks/${releaseTask.id}`, {
      method: "PATCH", cookie: priya,
      json: { state: "open", revision: canonicalTask.revision },
    });
    expect(reopened.status).toBe(200);
    expect(database.prepare("SELECT agreement_status AS status FROM speakers WHERE id = 'spk-d-priya'").get().status)
      .toBe("missing");

    workspace = (await (await api(env, "/events/devflow-conf-2027/speaker/content-workspace", {
      cookie: priya,
    })).json()).data;
    expect(workspace.speaker.agreementStatus).toBe("missing");
  });

  it("repairs stale profile readiness when complete fields are saved unchanged", async () => {
    database.prepare(`UPDATE speakers SET profile_status = 'incomplete', revision = revision + 1,
      updated_at = '2027-02-21T00:00:01Z'
      WHERE event_id = 'evt-devflow' AND id = 'spk-d-priya'`).run();
    let workspace = (await (await api(env, "/events/devflow-conf-2027/speaker/content-workspace", {
      cookie: priya,
    })).json()).data;
    expect(workspace.speaker.profileStatus).toBe("incomplete");
    const ownerRepair = await api(env, "/events/devflow-conf-2027/speaker/profile", {
      method: "PATCH", cookie: priya, json: ownedProfileInput(workspace.speaker),
    });
    expect(ownerRepair.status).toBe(200);
    expect((await ownerRepair.json()).data.profileStatus).toBe("ready");

    database.prepare(`UPDATE speakers SET profile_status = 'incomplete', revision = revision + 1,
      updated_at = '2027-02-21T00:00:03Z'
      WHERE event_id = 'evt-devflow' AND id = 'spk-d-priya'`).run();
    const roster = (await (await api(env, "/events/devflow-conf-2027/speakers", {
      cookie: organizer,
    })).json()).data;
    const profile = roster.speakers.find((speaker) => speaker.profile.id === "spk-d-priya").profile;
    const organizerRepair = await api(env, "/events/devflow-conf-2027/speakers/spk-d-priya/profile", {
      method: "PATCH", cookie: organizer, json: profileInput(profile),
    });
    expect(organizerRepair.status).toBe(200);
    expect((await organizerRepair.json()).data.profileStatus).toBe("ready");
  });

  it("includes userless speakers for organizers with a null private contact", async () => {
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, headshot_url,
      headshot_fallback, profile_status, agreement_status, public_visibility,
      contact_email, workflow_status, social_urls_json, travel_preferences, revision, updated_at
    ) VALUES (
      'spk-userless', 'evt-devflow', NULL, 'userless-speaker', 'Userless Speaker',
      'Guest', 'Independent', 'Imported speaker without an account.', NULL,
      'US', 'incomplete', 'missing', 'private', '', 'confirmed',
      '{"website":null,"linkedin":null,"x":null}', '', 1, '2027-02-20T18:00:00Z'
    )`).run();
    database.prepare(`INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('proposal-presenter-userless', 'evt-devflow', 'prop-d-supplemental-submitted', 'spk-userless', 'co_presenter')`).run();
    database.prepare(`INSERT INTO decisions (
      id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
    ) VALUES (
      'dec-userless', 'evt-devflow', 'prop-d-supplemental-submitted', 'accept',
      'Fixture acceptance.', 'usr-devflow-organizer', '2027-02-20T18:00:00Z'
    )`).run();
    database.prepare(`INSERT INTO program_sessions (
      id, event_id, source_proposal_id, slug, title, abstract, track, format,
      duration_minutes, publication_status, deliverables_status, approval_status, created_at, updated_at
    ) VALUES (
      'ses-userless', 'evt-devflow', 'prop-d-supplemental-submitted', 'userless-session',
      'Userless session', 'Fixture session.', 'Developer Experience', 'talk', 30,
      'private', 'missing', 'pending', '2027-02-20T18:00:00Z', '2027-02-20T18:00:00Z'
    )`).run();
    database.prepare(`INSERT INTO acceptances (
      id, event_id, proposal_id, decision_id, program_session_id,
      accepted_by_user_id, idempotency_key, accepted_at
    ) VALUES (
      'acc-userless', 'evt-devflow', 'prop-d-supplemental-submitted', 'dec-userless',
      'ses-userless', 'usr-devflow-organizer', 'fixture:userless', '2027-02-20T18:00:00Z'
    )`).run();
    database.prepare(`INSERT INTO session_presenters (
      id, event_id, program_session_id, speaker_id, role
    ) VALUES ('presenter-userless', 'evt-devflow', 'ses-userless', 'spk-userless', 'co_presenter')`).run();

    const rosterResponse = await api(env, "/events/devflow-conf-2027/speakers", { cookie: organizer });
    expect(rosterResponse.status).toBe(200);
    const roster = (await rosterResponse.json()).data;
    expect(roster.speakers.find(({ profile }) => profile.id === "spk-userless").profile.contactEmail).toBeNull();
    const contentResponse = await api(env, "/events/devflow-conf-2027/content", { cookie: organizer });
    expect(contentResponse.status).toBe(200);
    const content = (await contentResponse.json()).data;
    expect(content.sessions.find(({ id }) => id === "ses-userless").presenters
      .find(({ id }) => id === "spk-userless").contactEmail).toBeNull();
  });

  it("creates independent organizer tasks with durable provenance", async () => {
    env.DB.countTriggerWrites = true;
    const body = {
      targets: [
        { speakerId: "spk-d-priya", sessionId: "ses-d-2" },
        { speakerId: "spk-d-marcus", sessionId: "ses-d-2" },
      ],
      taskKey: "confirm-av",
      label: "Confirm AV requirements",
      dueAt: "2027-04-01T17:00:00Z",
    };
    const first = await api(env, "/events/devflow-conf-2027/speakers/tasks", { method: "POST", cookie: organizer, json: body });
    expect(first.status).toBe(200);
    const retry = await api(env, "/events/devflow-conf-2027/speakers/tasks", { method: "POST", cookie: organizer, json: body });
    expect(retry.status).toBe(200);
    const rows = database.prepare("SELECT speaker_id AS speakerId, created_by_user_id AS actor FROM speaker_tasks WHERE task_key = 'confirm-av' ORDER BY speaker_id").all();
    expect(rows).toEqual([
      { speakerId: "spk-d-marcus", actor: "usr-devflow-organizer" },
      { speakerId: "spk-d-priya", actor: "usr-devflow-organizer" },
    ]);
    expect(database.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "pending" });
  });

  it("treats reordered social URL JSON as the same profile", async () => {
    database.prepare(`UPDATE speakers SET
      social_urls_json = '{"x":null,"linkedin":null,"website":null}',
      revision = revision + 1, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'spk-d-priya'`).run();
    const workspace = (await (await api(env, "/events/devflow-conf-2027/speaker/content-workspace", {
      cookie: priya,
    })).json()).data;
    const before = workspace.speaker.revision;
    const response = await api(env, "/events/devflow-conf-2027/speaker/profile", {
      method: "PATCH", cookie: priya, json: ownedProfileInput(workspace.speaker),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.revision).toBe(before);
  });

  it("streams only current approved event deliverables as a sanitized ZIP", async () => {
    const firstBytes = new TextEncoder().encode("first approved deck");
    const secondBytes = new TextEncoder().encode("second approved deck");
    const first = insertDeliverable(database, {
      id: "archive-version-1",
      requestId: "archive-request-1",
      requestKey: "archive-one",
      requestLabel: "Final / Deck",
      filename: "../../deck.pdf",
      objectKey: "events/evt-devflow/deliverables/archive-1",
      bytes: firstBytes,
    });
    const second = insertDeliverable(database, {
      id: "archive-version-2",
      requestId: "archive-request-2",
      requestKey: "archive-two",
      requestLabel: "Final / Deck",
      filename: "deck.pdf",
      objectKey: "events/evt-devflow/deliverables/archive-2",
      bytes: secondBytes,
      reviewedAt: "2027-04-20T17:01:00Z",
    });
    insertDeliverable(database, {
      id: "archive-outdated-1",
      requestId: "archive-request-outdated",
      requestKey: "archive-outdated",
      requestLabel: "Outdated",
      filename: "old.pdf",
      objectKey: "events/evt-devflow/deliverables/outdated-1",
      bytes: new TextEncoder().encode("old approved version"),
      reviewedAt: "2027-04-20T17:02:00Z",
    });
    insertDeliverable(database, {
      id: "archive-outdated-2",
      requestId: "archive-request-outdated",
      requestKey: "archive-outdated",
      requestLabel: "Outdated",
      filename: "new.pdf",
      objectKey: "events/evt-devflow/deliverables/outdated-2",
      bytes: new TextEncoder().encode("new unapproved version"),
      versionNumber: 2,
      outcome: "changes_requested",
      reviewedAt: "2027-04-20T17:03:00Z",
    });
    insertDeliverable(database, {
      eventId: "evt-fieldnotes",
      sessionId: "ses-f-1",
      speakerId: "spk-f-lina",
      organizerId: "usr-fieldnotes-organizer",
      id: "archive-other-event",
      requestId: "archive-request-other-event",
      requestKey: "archive-other-event",
      requestLabel: "Other event",
      filename: "private-other-event.pdf",
      objectKey: "events/evt-fieldnotes/deliverables/other-event",
      bytes: new TextEncoder().encode("other event"),
      reviewedAt: "2027-04-20T17:04:00Z",
    });
    await putDeliverable(bucket, first, firstBytes);
    await putDeliverable(bucket, second, secondBytes);

    const path = "/events/devflow-conf-2027/content/deliverables.zip";
    expect((await api(env, path)).status).toBe(401);
    expect((await api(env, path, { cookie: reviewer })).status).toBe(403);
    expect((await api(env, path, { cookie: priya })).status).toBe(403);

    const response = await api(env, path, { cookie: organizer });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("devflow-conf-2027-approved-deliverables.zip");
    const archive = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(archive.byteLength);
    const entries = zipEntries(archive);
    expect(entries.map(({ name }) => name)).toEqual([
      "Taming 40-Minute CI- Incremental Builds at Monorepo Scale/01 - Final - Deck - deck.pdf",
      "Taming 40-Minute CI- Incremental Builds at Monorepo Scale/02 - Final - Deck - deck.pdf",
    ]);
    expect(entries.map(({ body }) => new TextDecoder().decode(body))).toEqual([
      "first approved deck",
      "second approved deck",
    ]);
    expect(entries.every(({ name }) => !name.includes("..") && !name.includes("\\"))).toBe(true);
    expect(bucket.maxActiveStreams).toBe(1);
    expect(bucket.activeStreams).toBe(0);
  });

  it("lists and authorizes old deliverable versions without exposing storage URLs", async () => {
    const oldBytes = new TextEncoder().encode("old private deck");
    const currentBytes = new TextEncoder().encode("current private deck");
    const oldVersion = insertDeliverable(database, {
      id: "library-version-1",
      requestId: "library-request",
      requestKey: "library-slides",
      requestLabel: "Conference slides",
      filename: "slides-draft.pdf",
      objectKey: "events/evt-devflow/deliverables/library-v1",
      bytes: oldBytes,
      reviewedAt: "2027-04-20T17:00:00Z",
    });
    const currentVersion = insertDeliverable(database, {
      id: "library-version-2",
      requestId: "library-request",
      requestKey: "library-slides",
      requestLabel: "Conference slides",
      filename: "slides-final.pdf",
      objectKey: "events/evt-devflow/deliverables/library-v2",
      bytes: currentBytes,
      versionNumber: 2,
      reviewedAt: "2027-04-20T17:01:00Z",
    });
    await putDeliverable(bucket, oldVersion, oldBytes);
    await putDeliverable(bucket, currentVersion, currentBytes);

    const contentResponse = await api(env, "/events/devflow-conf-2027/content", { cookie: organizer });
    expect(contentResponse.status).toBe(200);
    const content = (await contentResponse.json()).data;
    const versions = content.sessions.find((session) => session.id === "ses-d-2").versions
      .filter((version) => version.requestId === "library-request");
    expect(versions.map((version) => ({
      id: version.id,
      number: version.versionNumber,
      path: version.downloadPath,
      publicUrl: version.publicUrl,
    }))).toEqual([
      {
        id: "library-version-1", number: 1,
        path: "/api/events/devflow-conf-2027/content/deliverables/library-version-1/file",
        publicUrl: null,
      },
      {
        id: "library-version-2", number: 2,
        path: "/api/events/devflow-conf-2027/content/deliverables/library-version-2/file",
        publicUrl: null,
      },
    ]);
    expect(JSON.stringify(versions)).not.toContain("objectKey");
    expect(JSON.stringify(versions)).not.toContain("r2.dev");

    const oldPath = "/events/devflow-conf-2027/content/deliverables/library-version-1/file";
    expect((await api(env, oldPath)).status).toBe(401);
    expect((await api(env, oldPath, { cookie: reviewer })).status).toBe(403);
    expect((await api(env, oldPath, { cookie: priya })).status).toBe(403);
    const download = await api(env, oldPath, { cookie: organizer });
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(download.headers.get("content-disposition")).toContain("slides-draft.pdf");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(oldBytes);
  });

  it("fails closed before streaming when private object metadata diverges", async () => {
    const bytes = new TextEncoder().encode("approved deck");
    const row = insertDeliverable(database, {
      id: "archive-bad-metadata",
      requestId: "archive-request-bad-metadata",
      requestKey: "archive-bad-metadata",
      requestLabel: "Final deck",
      filename: "deck.pdf",
      objectKey: "events/evt-devflow/deliverables/bad-metadata",
      bytes,
    });
    await putDeliverable(bucket, row, bytes);
    bucket.objects.get(row.objectKey).customMetadata.eventScope = "evt-fieldnotes";
    const log = console.error;
    console.error = () => {};
    try {
      const response = await api(env, "/events/devflow-conf-2027/content/deliverables.zip", { cookie: organizer });
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
      expect(bucket.maxActiveStreams).toBe(0);
    } finally {
      console.error = log;
    }
  });

  it("errors an in-progress archive when later object metadata changes", async () => {
    const firstBytes = new TextEncoder().encode("first approved deck");
    const secondBytes = new TextEncoder().encode("second approved deck");
    const first = insertDeliverable(database, {
      id: "archive-stream-change-1",
      requestId: "archive-stream-request-1",
      requestKey: "archive-stream-one",
      requestLabel: "First deck",
      filename: "first.pdf",
      objectKey: "events/evt-devflow/deliverables/archive-stream-1",
      bytes: firstBytes,
    });
    const second = insertDeliverable(database, {
      id: "archive-stream-change-2",
      requestId: "archive-stream-request-2",
      requestKey: "archive-stream-two",
      requestLabel: "Second deck",
      filename: "second.pdf",
      objectKey: "events/evt-devflow/deliverables/archive-stream-2",
      bytes: secondBytes,
      reviewedAt: "2027-04-20T17:01:00Z",
    });
    await putDeliverable(bucket, first, firstBytes);
    await putDeliverable(bucket, second, secondBytes);
    bucket.mutateMetadataOnGetKey = second.objectKey;

    const response = await api(env, "/events/devflow-conf-2027/content/deliverables.zip", { cookie: organizer });
    expect(response.status).toBe(200);
    const advertisedSize = Number(response.headers.get("content-length"));
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(advertisedSize).toBeGreaterThan(firstBytes.byteLength + secondBytes.byteLength);
  });

  it("persists versioned files, comments, ordered reviews, and approval readiness", async () => {
    // Cloudflare D1 can include trigger-side writes in meta.changes. The
    // canonical row lookup, not an exact count of one, determines success.
    env.DB.countTriggerWrites = true;
    const requestBody = {
      requestKey: "final-slides",
      requestType: "presentation",
      label: "Final slides",
      instructions: "Upload the final deck.",
      dueAt: "2027-05-01T17:00:00Z",
      allowedContentTypes: ["application/pdf"],
      maxBytes: 10485760,
      required: true,
    };
    const requestResponse = await api(env, "/events/devflow-conf-2027/content/ses-d-2/requests", {
      method: "POST", cookie: organizer, json: requestBody,
    });
    expect(requestResponse.status).toBe(200);
    const request = (await requestResponse.json()).data;
    expect(database.prepare("SELECT deliverables_status AS status, approval_status AS approval FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "missing", approval: "pending" });

    const form = new FormData();
    form.set("file", new File(["%PDF-1.7\nslides"], "slides.pdf", { type: "application/pdf" }));
    form.set("note", "Final review");
    const uploadPath = `/events/devflow-conf-2027/speaker/deliverables/${request.id}/versions`;
    const upload = await api(env, uploadPath, { method: "POST", cookie: priya, form, headers: { "Idempotency-Key": "slides-final-001" } });
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()).data;
    expect(uploaded.session.deliverablesStatus).toBe("submitted");
    const retryForm = new FormData();
    retryForm.set("file", new File(["%PDF-1.7\nslides"], "slides.pdf", { type: "application/pdf" }));
    retryForm.set("note", "Final review");
    const retry = await api(env, uploadPath, { method: "POST", cookie: priya, form: retryForm, headers: { "Idempotency-Key": "slides-final-001" } });
    expect(retry.status).toBe(200);
    expect((await retry.json()).data.version.id).toBe(uploaded.version.id);
    expect(bucket.objects.size).toBe(1);

    expect((await api(env, uploaded.version.downloadPath.replace("/api", ""), { cookie: priya })).status).toBe(200);
    expect((await api(env, uploaded.version.downloadPath.replace("/api", ""), { cookie: marcus })).status).toBe(200);
    expect((await api(env, uploaded.version.downloadPath.replace("/api", ""), { cookie: elena })).status).toBe(404);

    const comment = { versionId: uploaded.version.id, body: "Please check slide 12." };
    expect((await api(env, "/events/devflow-conf-2027/speaker/sessions/ses-d-2/comments", { method: "POST", cookie: priya, json: comment })).status).toBe(200);
    expect((await api(env, "/events/devflow-conf-2027/content/ses-d-2/comments", { method: "POST", cookie: organizer, json: { ...comment, body: "Checked." } })).status).toBe(200);

    let content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    let session = content.sessions.find((value) => value.id === "ses-d-2");
    const otherSession = content.sessions.find((value) => value.id === "ses-d-3");
    const crossSessionReview = await api(env, "/events/devflow-conf-2027/content/ses-d-3/reviews", {
      method: "POST", cookie: organizer, json: {
        versionId: uploaded.version.id,
        idempotencyKey: "review-cross-session-001",
        outcome: "approved",
        comment: "Wrong session.",
        expectedSessionRevision: otherSession.revision,
      },
    });
    expect(crossSessionReview.status).toBe(409);
    expect(database.prepare("SELECT COUNT(*) AS count FROM content_reviews WHERE idempotency_key = 'review-cross-session-001'").get().count).toBe(0);
    const reviewBase = { versionId: uploaded.version.id, outcome: "approved", comment: "Ready." };
    const reviewPayload = { ...reviewBase, idempotencyKey: "review-slides-001", expectedSessionRevision: session.revision };
    const [reviewFirst, reviewRace] = await Promise.all([
      api(env, "/events/devflow-conf-2027/content/ses-d-2/reviews", { method: "POST", cookie: organizer, json: reviewPayload }),
      api(env, "/events/devflow-conf-2027/content/ses-d-2/reviews", { method: "POST", cookie: organizer, json: reviewPayload }),
    ]);
    expect([reviewFirst.status, reviewRace.status]).toEqual([200, 200]);
    expect((await reviewFirst.json()).data.id).toBe((await reviewRace.json()).data.id);
    expect((await api(env, "/events/devflow-conf-2027/content/ses-d-2/reviews", {
      method: "POST", cookie: organizer,
      json: { ...reviewPayload, comment: "Conflicting retry." },
    })).status).toBe(409);
    content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    session = content.sessions.find((value) => value.id === "ses-d-2");
    expect(session.deliverablesStatus).toBe("ready");

    for (const task of session.tasks.filter((value) => value.state === "open")) {
      const route = `/events/devflow-conf-2027/speakers/${database.prepare("SELECT speaker_id AS id FROM speaker_tasks WHERE id = ?").get(task.id).id}/tasks/${task.id}`;
      expect((await api(env, route, { method: "PATCH", cookie: organizer, json: { state: "waived", revision: task.revision } })).status).toBe(200);
    }
    content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    session = content.sessions.find((value) => value.id === "ses-d-2");
    expect(session.unmetApprovalGates).toEqual([]);
    expect((await api(env, "/events/devflow-conf-2027/content/ses-d-2/approval", {
      method: "PATCH", cookie: organizer,
      json: { approvalStatus: "approved", expectedRevision: session.revision },
    })).status).toBe(200);

    content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    session = content.sessions.find((value) => value.id === "ses-d-2");
    const requestUpdate = await api(env, `/events/devflow-conf-2027/content/ses-d-2/requests/${request.id}`, {
      method: "PATCH", cookie: organizer, json: {
        label: "Final reviewed slides",
        instructions: request.instructions,
        dueAt: request.dueAt,
        allowedContentTypes: request.allowedContentTypes,
        maxBytes: request.maxBytes,
        required: request.required,
        active: request.active,
        revision: request.revision,
      },
    });
    expect(requestUpdate.status).toBe(200);
    content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    session = content.sessions.find((value) => value.id === "ses-d-2");
    expect(session.approvalStatus).toBe("pending");
    expect((await api(env, "/events/devflow-conf-2027/content/ses-d-2/approval", {
      method: "PATCH", cookie: organizer,
      json: { approvalStatus: "approved", expectedRevision: session.revision },
    })).status).toBe(200);
    content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    session = content.sessions.find((value) => value.id === "ses-d-2");
    const completedTask = session.tasks.find((value) => value.state === "complete");
    const completedTaskSpeaker = database.prepare("SELECT speaker_id AS id FROM speaker_tasks WHERE id = ?").get(completedTask.id).id;
    const reopened = await api(env, `/events/devflow-conf-2027/speakers/${completedTaskSpeaker}/tasks/${completedTask.id}`, {
      method: "PATCH", cookie: organizer, json: { state: "open", revision: completedTask.revision },
    });
    expect(reopened.status).toBe(200);
    content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    session = content.sessions.find((value) => value.id === "ses-d-2");
    expect(session.approvalStatus).toBe("pending");
    const adverse = await api(env, "/events/devflow-conf-2027/content/ses-d-2/reviews", {
      method: "POST", cookie: organizer,
      json: { versionId: uploaded.version.id, idempotencyKey: "review-slides-002", outcome: "changes_requested", comment: "One fix.", expectedSessionRevision: session.revision },
    });
    expect(adverse.status).toBe(200);
    const times = database.prepare("SELECT reviewed_at AS at FROM content_reviews WHERE version_id = ? ORDER BY reviewed_at").all(uploaded.version.id).map((row) => row.at);
    expect(times[1] > times[0]).toBe(true);
    expect(database.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get().status).toBe("pending");
  });

  it("edits and restores session content without deleting history", async () => {
    let content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    const session = content.sessions.find((value) => value.id === "ses-d-7");
    const noChanges = await api(env, "/events/devflow-conf-2027/content/ses-d-7", {
      method: "PATCH", cookie: organizer, json: {
        title: session.title, abstract: session.abstract, track: session.track,
        format: session.format, durationMinutes: session.durationMinutes,
        changeNote: "No effective change.", expectedRevision: session.revision,
      },
    });
    expect(noChanges.status).toBe(409);
    expect((await noChanges.json()).error.code).toBe("NO_CHANGES");
    const edited = await api(env, "/events/devflow-conf-2027/content/ses-d-7", {
      method: "PATCH", cookie: organizer, json: {
        title: "Maintainers at Scale: Field Notes", abstract: session.abstract,
        track: session.track, format: session.format, durationMinutes: session.durationMinutes,
        changeNote: "Clarified the title.", expectedRevision: session.revision,
      },
    });
    expect(edited.status).toBe(200);
    const firstHistory = (await edited.json()).data;
    const afterFirstEdit = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data
      .sessions.find((value) => value.id === "ses-d-7");
    const secondEdit = await api(env, "/events/devflow-conf-2027/content/ses-d-7", {
      method: "PATCH", cookie: organizer, json: {
        title: afterFirstEdit.title, abstract: `${afterFirstEdit.abstract} Attendees should bring a laptop.`,
        track: afterFirstEdit.track, format: afterFirstEdit.format, durationMinutes: afterFirstEdit.durationMinutes,
        changeNote: "Added attendee preparation.", expectedRevision: afterFirstEdit.revision,
      },
    });
    expect(secondEdit.status).toBe(200);
    const secondHistory = (await secondEdit.json()).data;
    expect(firstHistory.title).toBe("Maintainers at Scale");
    expect(secondHistory.title).toBe("Maintainers at Scale: Field Notes");
    expect(secondHistory.abstract).toBe(afterFirstEdit.abstract);

    const restored = await api(env, `/events/devflow-conf-2027/content/ses-d-7/history/${secondHistory.id}/restore`, { method: "POST", cookie: organizer });
    expect(restored.status).toBe(200);
    const restoredAgain = await api(env, `/events/devflow-conf-2027/content/ses-d-7/history/${secondHistory.id}/restore`, { method: "POST", cookie: organizer });
    expect(restoredAgain.status).toBe(200);
    content = (await (await api(env, "/events/devflow-conf-2027/content", { cookie: organizer })).json()).data;
    const restoredSession = content.sessions.find((value) => value.id === "ses-d-7");
    expect(restoredSession.title).toBe("Maintainers at Scale: Field Notes");
    expect(restoredSession.abstract).toBe(afterFirstEdit.abstract);
    expect(restoredSession.abstract).not.toContain("Attendees should bring a laptop.");
    expect(database.prepare("SELECT COUNT(*) AS count FROM session_content_history WHERE program_session_id = 'ses-d-7'").get().count).toBe(3);
  });

  it("records organizer profile snapshots and restores them as a new audit event", async () => {
    let roster = (await (await api(env, "/events/devflow-conf-2027/speakers", { cookie: organizer })).json()).data;
    const current = roster.speakers.find((value) => value.profile.id === "spk-d-priya").profile;
    const notReady = await api(env, "/events/devflow-conf-2027/speakers/spk-d-priya/profile", {
      method: "PATCH", cookie: organizer,
      json: profileInput(current, { bio: "", publicVisibility: "published" }),
    });
    expect(notReady.status).toBe(409);
    expect((await notReady.json()).error.code).toBe("READINESS_BLOCKED");
    const edited = await api(env, "/events/devflow-conf-2027/speakers/spk-d-priya/profile", {
      method: "PATCH", cookie: organizer,
      json: profileInput(current, {
        bio: `${current.bio} Organizer edit.`,
        contactEmail: "priya-updated@example.test",
      }),
    });
    expect(edited.status).toBe(200);
    roster = (await (await api(env, "/events/devflow-conf-2027/speakers", { cookie: organizer })).json()).data;
    const updatedEntry = roster.speakers.find((value) => value.profile.id === "spk-d-priya").history
      .find((value) => value.action === "updated");
    expect(updatedEntry.profile.bio).toBe(current.bio);
    expect(updatedEntry.profile).not.toHaveProperty("contactEmail");
    expect(database.prepare("SELECT profile_json AS profile FROM speaker_content_history WHERE id = ?")
      .get(updatedEntry.id).profile).not.toContain("contactEmail");
    const restored = await api(env, `/events/devflow-conf-2027/speakers/spk-d-priya/history/${updatedEntry.id}/restore`, {
      method: "POST", cookie: organizer,
    });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data).toMatchObject({
      bio: current.bio,
      contactEmail: "priya-updated@example.test",
    });
    const restoredAgain = await api(env, `/events/devflow-conf-2027/speakers/spk-d-priya/history/${updatedEntry.id}/restore`, {
      method: "POST", cookie: organizer,
    });
    expect(restoredAgain.status).toBe(200);
    expect((await restoredAgain.json()).data.bio).toBe(current.bio);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speaker_content_history WHERE speaker_id = 'spk-d-priya'").get().count).toBe(2);
  });

  it("skips malformed history in the roster and returns an explicit restore integrity error", async () => {
    database.prepare(`INSERT INTO speaker_content_history (
      id, event_id, speaker_id, action, profile_json, change_note, actor_user_id, created_at
    ) VALUES (
      'history-malformed', 'evt-devflow', 'spk-d-priya', 'updated', '{}',
      'Malformed fixture', 'usr-devflow-organizer', '2027-04-20T17:00:00Z'
    )`).run();

    const rosterResponse = await api(env, "/events/devflow-conf-2027/speakers", { cookie: organizer });
    expect(rosterResponse.status).toBe(200);
    const roster = (await rosterResponse.json()).data;
    expect(roster.speakers.find(({ profile }) => profile.id === "spk-d-priya").history
      .some(({ id }) => id === "history-malformed")).toBe(false);

    const restore = await api(env, "/events/devflow-conf-2027/speakers/spk-d-priya/history/history-malformed/restore", {
      method: "POST", cookie: organizer,
    });
    expect(restore.status).toBe(409);
    expect((await restore.json()).error.code).toBe("HISTORY_DATA_INTEGRITY");
  });

  it("replaces only the old headshot and serves cache-safe published bytes", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const firstForm = new FormData();
    firstForm.set("file", new File([png], "priya.png", { type: "image/png" }));
    const first = await api(env, "/events/devflow-conf-2027/speaker/headshot", { method: "POST", cookie: priya, form: firstForm });
    expect(first.status).toBe(200);
    const firstProfile = (await first.json()).data;
    const oldKey = [...bucket.objects.keys()][0];
    const publicFirst = await api(env, firstProfile.headshot.publicUrl.replace("/api", ""));
    expect(publicFirst.status).toBe(200);
    expect(publicFirst.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    const profileOnlyUpdate = await api(env, "/events/devflow-conf-2027/speaker/profile", {
      method: "PATCH", cookie: priya,
      json: ownedProfileInput(firstProfile, { bio: `${firstProfile.bio} Updated without replacing the headshot.` }),
    });
    expect(profileOnlyUpdate.status).toBe(200);
    expect((await profileOnlyUpdate.json()).data.headshot.publicUrl).toBe(firstProfile.headshot.publicUrl);
    expect((await api(env, firstProfile.headshot.publicUrl.replace("/api", ""))).status).toBe(200);

    const secondForm = new FormData();
    secondForm.set("file", new File([new Uint8Array([...png, 2])], "priya-new.png", { type: "image/png" }));
    const second = await api(env, "/events/devflow-conf-2027/speakers/spk-d-priya/headshot", { method: "POST", cookie: organizer, form: secondForm });
    expect(second.status).toBe(200);
    const secondProfile = (await second.json()).data;
    expect(bucket.deleted).toEqual([oldKey]);
    expect(bucket.objects.size).toBe(1);
    expect((await api(env, firstProfile.headshot.publicUrl.replace("/api", ""))).status).toBe(404);
    expect((await api(env, secondProfile.headshot.publicUrl.replace("/api", ""))).status).toBe(200);

    const roster = (await (await api(env, "/events/devflow-conf-2027/speakers", { cookie: organizer })).json()).data;
    const audit = roster.speakers.find((value) => value.profile.id === "spk-d-priya").history.find((value) => value.action === "headshot_uploaded");
    expect(audit).toBeTruthy();
    const blockedRestore = await api(env, `/events/devflow-conf-2027/speakers/spk-d-priya/history/${audit.id}/restore`, { method: "POST", cookie: organizer });
    expect(blockedRestore.status).toBe(409);
    expect((await blockedRestore.json()).error.code).toBe("RESTORE_NOT_ALLOWED");
  });

  it("does not treat a missing public identity as an empty user id", async () => {
    database.prepare(`INSERT INTO users (id, email, display_name, created_at)
      VALUES ('', 'empty-id@example.test', 'Empty Id', '2027-04-20T17:00:00Z')`).run();
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, headshot_url,
      headshot_fallback, profile_status, agreement_status, public_visibility,
      contact_email, workflow_status, social_urls_json, travel_preferences,
      headshot_object_key, headshot_original_filename, headshot_content_type,
      headshot_byte_size, headshot_sha256, headshot_uploaded_at, revision, updated_at
    ) VALUES (
      'spk-empty-id', 'evt-devflow', '', 'empty-id-speaker', 'Empty Id Speaker',
      'Guest', 'Independent', 'Private speaker fixture.', NULL, 'EI', 'ready', 'signed',
      'private', 'empty-id@example.test', 'confirmed',
      '{"website":null,"linkedin":null,"x":null}', '',
      'events/evt-devflow/headshots/spk-empty-id/private.png', 'private.png', 'image/png',
      8, '${"a".repeat(64)}', '2027-04-20T17:00:00Z', 1, '2027-04-20T17:00:00Z'
    )`).run();

    const response = await api(env, "/public/events/devflow-conf-2027/speakers/empty-id-speaker/headshot");
    expect(response.status).toBe(404);
  });
});
