import { createHash, pbkdf2Sync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index.ts";
import { PASSWORD_ITERATIONS } from "../src/password.ts";

class Statement {
  constructor(statement) { this.statement = statement; this.params = []; }
  bind(...params) { const next = new Statement(this.statement); next.params = params; return next; }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
  async run() { const result = this.statement.run(...this.params); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async first(column) { const row = this.statement.get(...this.params) ?? null; return column && row ? row[column] : row; }
}
class Database {
  constructor(database) { this.database = database; }
  prepare(query) { return new Statement(this.database.prepare(query)); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.database.exec("COMMIT"); return results; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
function fixtureDatabase() {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((value) => /^\d{4}_[a-z0-9_]+\.sql$/.test(value)).sort())
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  database.exec(readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8"));
  return database;
}
const headers = { Origin: "http://localhost", "Content-Type": "application/json", "X-ConfPilot-Request": "1", "Sec-Fetch-Site": "same-origin" };
const limiter = { limit: async () => ({ success: true }) };
function addSession(database, userId, token) {
  database.prepare(`INSERT INTO auth_sessions (id,user_id,token_hash,expires_at,revoked_at,created_at)
    VALUES (?,?,?,'2099-01-01T00:00:00Z',NULL,'2026-08-13T00:00:00Z')`)
    .run(`session-${token}`, userId, createHash("sha256").update(token).digest("hex"));
  return `__Host-confpilot_session=${token}`;
}
function addAccount(database, id, email) {
  const salt="00112233445566778899aabbccddeeff";
  const hash=pbkdf2Sync("speaker-password-123",Buffer.from(salt,"hex"),PASSWORD_ITERATIONS,32,"sha256").toString("hex");
  database.prepare("INSERT INTO users (id,email,display_name,created_at) VALUES (?,?,?,'2026-08-13T00:00:00Z')").run(id,email,"Claiming Speaker");
  database.prepare(`INSERT INTO user_credentials (user_id,password_salt,password_hash,algorithm,iterations,created_at,updated_at)
    VALUES (?,?,?,'pbkdf2-sha256',?,'2026-08-13T00:00:00Z','2026-08-13T00:00:00Z')`).run(id,salt,hash,PASSWORD_ITERATIONS);
}
function addUnclaimedSpeaker(database, id="spk-claim", email="claim@example.test") {
  database.prepare(`INSERT INTO speakers (id,event_id,user_id,slug,name,title,company,bio,headshot_url,headshot_fallback,
    profile_status,agreement_status,public_visibility,contact_email,workflow_status,updated_at)
    VALUES (?,'evt-devflow',NULL,?,'Claim Speaker','Engineer','Example','Profile',NULL,'CS','incomplete','missing','private',?,'invited','2026-08-13T00:00:00Z')`)
    .run(id,id,email);
}
function request(path,{method="GET",cookie,body}={},env) {
  return createApp().request(`http://localhost${path}`,{ method,headers:{...(method==="GET"?{}:headers),...(cookie?{Cookie:cookie}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}) },env);
}
const tokenFrom = (path) => path.split("#")[1];

describe("speaker account claims", () => {
  let sqlite; let env; let organizerCookie;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-13T12:00:00Z")); sqlite=fixtureDatabase();
    env={DB:new Database(sqlite),LOGIN_SOURCE_RATE_LIMITER:limiter,LOGIN_ACCOUNT_RATE_LIMITER:limiter};
    organizerCookie=addSession(sqlite,"usr-devflow-organizer","claim-organizer"); addUnclaimedSpeaker(sqlite);
  });
  afterEach(()=>{sqlite.close();vi.useRealTimers();});
  async function invite(overrides={}) {
    const response=await request("/api/events/devflow-conf-2027/speaker-claims",{method:"POST",cookie:organizerCookie,
      body:{speakerId:"spk-claim",idempotencyKey:"speaker-claim-1",expiresInDays:7,...overrides}},env);
    return {response,body:await response.json()};
  }

  it("creates one token-hashed claim and immutable queued snapshot", async () => {
    const created=await invite(); expect(created.response.status).toBe(201);
    expect(created.body.data).toMatchObject({replayed:false,claim:{speaker:{id:"spk-claim"},email:"claim@example.test",state:"pending",outboxState:"queued"}});
    const token=tokenFrom(created.body.data.acceptPath);
    const row=sqlite.prepare(`SELECT claim.token_hash AS hash,message.text_body AS body FROM speaker_claim_invitations claim
      INNER JOIN message_outbox message ON message.id=claim.outbox_message_id`).get();
    expect(row.hash).toBe(createHash("sha256").update(token).digest("hex")); expect(row.body).toContain(`#${token}`);
    const replay=await invite(); expect(replay.body.data).toMatchObject({replayed:true,acceptPath:null});
    expect(sqlite.prepare("SELECT count(*) AS count FROM speaker_claim_invitations").get().count).toBe(1);
  });

  it("registers, links the exact existing profile, and reloads speaker-only access", async () => {
    const created=await invite(); const token=tokenFrom(created.body.data.acceptPath);
    const registered=await request("/api/speaker-claims/register",{method:"POST",body:{token,displayName:"Claim Speaker",password:"secure-speaker-pass-123"}},env);
    expect(registered.status).toBe(201); const body=await registered.json();
    expect(body.data.memberships).toEqual([{eventSlug:"devflow-conf-2027",role:"speaker"}]);
    expect(sqlite.prepare("SELECT user_id AS userId FROM speakers WHERE id='spk-claim'").get().userId).toBe(body.data.user.id);
    expect(() => sqlite.prepare("UPDATE speakers SET user_id='usr-devflow-organizer' WHERE id='spk-claim'").run())
      .toThrow(/speaker account link is immutable/);
    expect(sqlite.prepare("SELECT count(*) AS count FROM speakers WHERE id='spk-claim'").get().count).toBe(1);
    const cookie=/__Host-confpilot_session=([^;]+)/.exec(registered.headers.get("set-cookie")??"")?.[1];
    const workspace=await request("/api/events/devflow-conf-2027/speaker/content-workspace",{cookie:`__Host-confpilot_session=${cookie}`},env);
    expect(workspace.status).toBe(200); expect((await workspace.json()).data.speaker.id).toBe("spk-claim");
    expect((await request("/api/speaker-claims/register",{method:"POST",body:{token,displayName:"Again",password:"secure-speaker-pass-123"}},env)).status).toBe(410);
  });

  it("requires the exact existing account and preserves a pre-existing reviewer role", async () => {
    addAccount(sqlite,"usr-claim","claim@example.test"); addAccount(sqlite,"usr-wrong-claim","wrong-claim@example.test");
    const claimCookie=addSession(sqlite,"usr-claim","claim-user"); const wrongCookie=addSession(sqlite,"usr-wrong-claim","wrong-user");
    const created=await invite(); const token=tokenFrom(created.body.data.acceptPath);
    expect((await request("/api/speaker-claims/accept",{method:"POST",cookie:wrongCookie,body:{token}},env)).status).toBe(403);
    expect((await request("/api/speaker-claims/accept",{method:"POST",cookie:claimCookie,body:{token}},env)).status).toBe(200);
    expect(sqlite.prepare("SELECT role FROM event_memberships WHERE user_id='usr-claim'").get()).toEqual({role:"speaker"});

    addUnclaimedSpeaker(sqlite,"spk-conflict","conflict@example.test"); addAccount(sqlite,"usr-conflict","conflict@example.test");
    sqlite.prepare("INSERT INTO event_memberships (id,event_id,user_id,role,created_at) VALUES ('mem-conflict','evt-devflow','usr-conflict','reviewer','2026-08-13T12:00:00Z')").run();
    const reviewerCookie=addSession(sqlite,"usr-conflict","reviewer-claim-user");
    const additionalRole=await invite({speakerId:"spk-conflict",idempotencyKey:"speaker-additional-role"});
    expect(additionalRole.response.status).toBe(201);
    const accepted=await request("/api/speaker-claims/accept",{method:"POST",cookie:reviewerCookie,body:{token:tokenFrom(additionalRole.body.data.acceptPath)}},env);
    expect(accepted.status).toBe(200);
    expect(sqlite.prepare("SELECT role FROM event_memberships WHERE user_id='usr-conflict' ORDER BY role").all())
      .toEqual([{role:"reviewer"},{role:"speaker"}]);
  });

  it("rejects a claim when the invited email already has speaker access", async () => {
    addAccount(sqlite,"usr-existing-speaker","claim@example.test");
    sqlite.prepare(`INSERT INTO event_memberships
      (id,event_id,user_id,role,created_at) VALUES
      ('mem-existing-speaker','evt-devflow','usr-existing-speaker','speaker','2026-08-13T12:00:00Z')`).run();

    const conflict=await invite({idempotencyKey:"speaker-role-conflict"});

    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe("SPEAKER_CLAIM_CONFLICT");
    expect(sqlite.prepare("SELECT count(*) AS count FROM speaker_claim_invitations").get().count).toBe(0);
  });

  it("fails closed on contact-email drift, expiry, revocation, and cross-event access", async () => {
    const created=await invite({expiresInDays:1}); const token=tokenFrom(created.body.data.acceptPath);
    sqlite.prepare("UPDATE speakers SET contact_email='changed@example.test',revision=revision+1,updated_at='2026-08-13T12:00:01Z' WHERE id='spk-claim'").run();
    expect((await request("/api/speaker-claims/register",{method:"POST",body:{token,displayName:"Claim",password:"secure-speaker-pass-123"}},env)).status).toBe(410);
    sqlite.prepare("UPDATE speakers SET contact_email='claim@example.test',revision=revision+1,updated_at='2026-08-13T12:00:02Z' WHERE id='spk-claim'").run();
    const revoked=await request(`/api/events/devflow-conf-2027/speaker-claims/${created.body.data.claim.id}/revoke`,{method:"POST",cookie:organizerCookie},env);
    expect(revoked.status).toBe(200); expect((await revoked.json()).data.outboxState).toBe("suppressed");
    expect((await request("/api/speaker-claims/resolve",{method:"POST",body:{token}},env)).status).toBe(410);

    addUnclaimedSpeaker(sqlite,"spk-expire","expire@example.test"); const expiring=await invite({speakerId:"spk-expire",idempotencyKey:"speaker-expire",expiresInDays:1});
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    const replacement=await invite({speakerId:"spk-expire",idempotencyKey:"speaker-replacement",expiresInDays:2});
    expect(replacement.response.status).toBe(201);
    expect(sqlite.prepare("SELECT state,expired_at AS expiredAt FROM speaker_claim_invitations WHERE id=?").get(expiring.body.data.claim.id))
      .toEqual({state:"expired",expiredAt:"2026-08-14T12:00:00Z"});
    const fieldCookie=addSession(sqlite,"usr-fieldnotes-organizer","field-claim-organizer");
    expect((await request("/api/events/devflow-conf-2027/speaker-claims",{cookie:fieldCookie},env)).status).toBe(403);
    expect((await request("/api/events/devflow-conf-2027/speaker-claims",{},env)).status).toBe(401);
  });

  it("filters organizer claim history to one speaker and keeps newest-first order", async () => {
    const first=await invite({idempotencyKey:"speaker-filter-first"});
    addUnclaimedSpeaker(sqlite,"spk-filter-other","other-filter@example.test");
    await invite({speakerId:"spk-filter-other",idempotencyKey:"speaker-filter-other"});
    const response=await request("/api/events/devflow-conf-2027/speaker-claims?speakerId=spk-claim",{cookie:organizerCookie},env);
    expect(response.status).toBe(200);
    expect((await response.json()).data.claims.map(({id})=>id)).toEqual([first.body.data.claim.id]);
  });

  it("keeps one reviewer invitation per outbox message", () => {
    const indexes=sqlite.prepare("PRAGMA index_list('reviewer_invitations')").all();
    expect(indexes).toContainEqual(expect.objectContaining({name:"reviewer_invitations_outbox_message_unique",unique:1}));
  });

  it("requires an accepted receipt and speaker membership before linking at the database layer", () => {
    expect(()=>sqlite.prepare("UPDATE speakers SET user_id='usr-devflow-organizer' WHERE id='spk-claim'").run())
      .toThrow(/accepted same-event claim/);
  });

  it("rejects malformed legacy contact emails before creating a claim", async () => {
    sqlite.prepare("UPDATE speakers SET contact_email='not-an-email', revision=revision+1, updated_at='2026-08-13T12:00:01Z' WHERE id='spk-claim'").run();
    const created=await invite();
    expect(created.response.status).toBe(409);
    expect(created.body.error.code).toBe("SPEAKER_CLAIM_INELIGIBLE");
    expect(sqlite.prepare("SELECT count(*) AS count FROM speaker_claim_invitations").get().count).toBe(0);

    sqlite.prepare("UPDATE speakers SET contact_email='claim@example.test', name='Trailing Name ', revision=revision+1, updated_at='2026-08-13T12:00:02Z' WHERE id='spk-claim'").run();
    const malformedName=await invite({idempotencyKey:"speaker-malformed-name"});
    expect(malformedName.response.status).toBe(409);
    expect(malformedName.body.error.code).toBe("SPEAKER_CLAIM_INELIGIBLE");

    sqlite.prepare("UPDATE speakers SET name='', revision=revision+1, updated_at='2026-08-13T12:00:03Z' WHERE id='spk-claim'").run();
    const emptyName=await invite({idempotencyKey:"speaker-empty-name"});
    expect(emptyName.response.status).toBe(409);
    expect(emptyName.body.error.code).toBe("SPEAKER_CLAIM_INELIGIBLE");
  });

  it("accepts a claim when the leased outbox timestamp is one second ahead", async () => {
    addAccount(sqlite,"usr-clock-claim","claim@example.test");
    const cookie=addSession(sqlite,"usr-clock-claim","clock-claim-user");
    const created=await invite(); const token=tokenFrom(created.body.data.acceptPath);
    sqlite.prepare(`UPDATE message_outbox SET state='leased',attempt_count=1,lease_token='dispatcher-token-a',
      lease_expires_at='2026-08-13T12:05:01Z',updated_at='2026-08-13T12:00:01Z'
      WHERE id=(SELECT outbox_message_id FROM speaker_claim_invitations WHERE id=?)`).run(created.body.data.claim.id);

    const accepted=await request("/api/speaker-claims/accept",{method:"POST",cookie,body:{token}},env);
    expect(accepted.status).toBe(200);
    expect(sqlite.prepare("SELECT state,cancellation_code AS cancellationCode FROM message_outbox").get())
      .toEqual({state:"leased",cancellationCode:"INVITATION_ACCEPTED"});
  });

  it("accepts and revokes claims whose invitation timestamp is one second ahead", async () => {
    addAccount(sqlite,"usr-clock-claim","claim@example.test");
    const cookie=addSession(sqlite,"usr-clock-claim","clock-claim-user");
    vi.setSystemTime(new Date("2026-08-13T12:00:01Z"));
    const created=await invite(); const token=tokenFrom(created.body.data.acceptPath);
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));

    const accepted=await request("/api/speaker-claims/accept",{method:"POST",cookie,body:{token}},env);
    expect(accepted.status).toBe(200);
    expect(sqlite.prepare("SELECT state,accepted_at AS acceptedAt,updated_at AS updatedAt FROM speaker_claim_invitations WHERE id=?")
      .get(created.body.data.claim.id)).toEqual({state:"accepted",acceptedAt:"2026-08-13T12:00:01Z",updatedAt:"2026-08-13T12:00:01Z"});

    addUnclaimedSpeaker(sqlite,"spk-revoke-clock","revoke-clock@example.test");
    vi.setSystemTime(new Date("2026-08-13T12:00:01Z"));
    const revocable=await invite({speakerId:"spk-revoke-clock",idempotencyKey:"speaker-revoke-clock"});
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
    const revoked=await request(`/api/events/devflow-conf-2027/speaker-claims/${revocable.body.data.claim.id}/revoke`,
      {method:"POST",cookie:organizerCookie},env);
    expect(revoked.status).toBe(200);
    expect(sqlite.prepare("SELECT state,revoked_at AS revokedAt,updated_at AS updatedAt FROM speaker_claim_invitations WHERE id=?")
      .get(revocable.body.data.claim.id)).toEqual({state:"revoked",revokedAt:"2026-08-13T12:00:01Z",updatedAt:"2026-08-13T12:00:01Z"});
  });

  it("rate limits invalid register and authenticated accept tokens before lookup", async () => {
    let sourceCalls=0;
    env.LOGIN_SOURCE_RATE_LIMITER={limit:async()=>{sourceCalls+=1;return {success:true};}};
    const invalidToken="x".repeat(32);
    expect((await request("/api/speaker-claims/register",{method:"POST",body:{token:invalidToken,displayName:"Invalid Claim",password:"secure-speaker-pass-123"}},env)).status).toBe(410);
    expect((await request("/api/speaker-claims/accept",{method:"POST",cookie:organizerCookie,body:{token:invalidToken}},env)).status).toBe(410);
    expect(sourceCalls).toBe(2);
  });
});
