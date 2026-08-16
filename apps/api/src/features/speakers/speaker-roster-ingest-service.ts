import {
  speakerRosterIngestResponseSchema,
  speakerRosterRowSchema,
  type SpeakerRosterIngestOutcome,
  type SpeakerRosterIngestResponse,
} from "@confpilot/contracts";
import type { Database } from "../../runtime/database";

export interface RawSpeakerRosterRow {
  rowNumber: number;
  value: unknown;
  parseError?: string;
}

interface ExistingSpeaker {
  id: string;
  userId: string | null;
}

interface ExistingSpeakerLookup extends ExistingSpeaker {
  normalizedEmail: string;
}

interface ExistingAccountLookup {
  normalizedEmail: string;
  speakerId: string | null;
}

const EMAIL_LOOKUP_CHUNK_SIZE = 90;

function safeSlug(value: string) {
  const base = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 64).replace(/-+$/g, "");
  return base || "speaker";
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]?.toUpperCase()).join("") || "SP";
}

function invalidOutcome(row: RawSpeakerRosterRow): SpeakerRosterIngestOutcome | null {
  if (row.parseError) {
    return {
      rowNumber: row.rowNumber,
      status: "invalid",
      code: "MALFORMED_CSV",
      message: row.parseError,
      normalizedEmail: null,
      speakerId: null,
      linkedAccount: false,
    };
  }
  const result = speakerRosterRowSchema.safeParse(row.value);
  if (result.success) return null;
  return {
    rowNumber: row.rowNumber,
    status: "invalid",
    code: "VALIDATION_FAILED",
    message: result.error.issues.map((issue) =>
      `${issue.path.map(String).join(".") || "row"}: ${issue.message}`).join("; ").slice(0, 500),
    normalizedEmail: null,
    speakerId: null,
    linkedAccount: false,
  };
}

async function existingByEmail(database: Database, eventId: string, email: string) {
  return database.prepare(`SELECT id, user_id AS userId FROM speakers
    WHERE event_id = ? AND lower(trim(contact_email)) = ? LIMIT 1`)
    .bind(eventId, email).first<ExistingSpeaker>();
}

async function existingSpeakersByEmail(
  database: Database,
  eventId: string,
  emails: readonly string[],
) {
  const speakers = new Map<string, ExistingSpeaker>();
  for (let offset = 0; offset < emails.length; offset += EMAIL_LOOKUP_CHUNK_SIZE) {
    const chunk = emails.slice(offset, offset + EMAIL_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await database.prepare(`SELECT lower(trim(contact_email)) AS normalizedEmail,
        id, user_id AS userId FROM speakers
      WHERE event_id = ? AND lower(trim(contact_email)) IN (${placeholders})`)
      .bind(eventId, ...chunk).all<ExistingSpeakerLookup>();
    for (const speaker of result.results) speakers.set(speaker.normalizedEmail, speaker);
  }
  return speakers;
}

async function existingAccountsByEmail(
  database: Database,
  eventId: string,
  emails: readonly string[],
) {
  const accounts = new Map<string, ExistingAccountLookup>();
  for (let offset = 0; offset < emails.length; offset += EMAIL_LOOKUP_CHUNK_SIZE) {
    const chunk = emails.slice(offset, offset + EMAIL_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await database.prepare(`SELECT lower(trim(user.email)) AS normalizedEmail,
        speaker.id AS speakerId
      FROM users AS user
      LEFT JOIN speakers AS speaker ON speaker.event_id = ? AND speaker.user_id = user.id
      WHERE lower(trim(user.email)) IN (${placeholders})`)
      .bind(eventId, ...chunk).all<ExistingAccountLookup>();
    for (const account of result.results) accounts.set(account.normalizedEmail, account);
  }
  return accounts;
}

function existingSpeakerOutcome(
  rowNumber: number,
  email: string,
  existing: ExistingSpeaker,
): SpeakerRosterIngestOutcome {
  return {
    rowNumber,
    status: "duplicate",
    code: "DUPLICATE_EMAIL",
    message: "A speaker with this email already exists for the event.",
    normalizedEmail: email,
    speakerId: existing.id,
    linkedAccount: existing.userId !== null,
  };
}

async function duplicateOutcome(
  database: Database,
  eventId: string,
  rowNumber: number,
  email: string,
): Promise<SpeakerRosterIngestOutcome | null> {
  const existing = await existingByEmail(database, eventId, email);
  return existing ? existingSpeakerOutcome(rowNumber, email, existing) : null;
}

function accountOutcome(
  rowNumber: number,
  email: string,
  account: ExistingAccountLookup,
): SpeakerRosterIngestOutcome {
  if (account.speakerId) return {
    rowNumber,
    status: "duplicate",
    code: "DUPLICATE_EMAIL",
    message: "This account is already represented by a speaker for the event.",
    normalizedEmail: email,
    speakerId: account.speakerId,
    linkedAccount: true,
  };
  return {
    rowNumber,
    status: "conflict",
    code: "ACCOUNT_ROLE_CONFLICT",
    message: "An account already uses this email. No speaker profile was created because roster import cannot verify account ownership.",
    normalizedEmail: email,
    speakerId: null,
    linkedAccount: false,
  };
}

export async function ingestSpeakerRosterRows(
  database: Database,
  eventId: string,
  rows: readonly RawSpeakerRosterRow[],
): Promise<SpeakerRosterIngestResponse> {
  const outcomes: SpeakerRosterIngestOutcome[] = [];
  const seenEmails = new Set<string>();
  const validEmails = [...new Set(rows.flatMap((row) => {
    const parsed = row.parseError ? null : speakerRosterRowSchema.safeParse(row.value);
    return parsed?.success ? [parsed.data.email] : [];
  }))];
  const existingSpeakers = await existingSpeakersByEmail(database, eventId, validEmails);
  const existingAccounts = await existingAccountsByEmail(database, eventId, validEmails);

  for (const row of rows) {
    const invalid = invalidOutcome(row);
    if (invalid) {
      outcomes.push(invalid);
      continue;
    }
    const value = speakerRosterRowSchema.parse(row.value);
    const email = value.email;
    const existing = existingSpeakers.get(email);
    if (seenEmails.has(email) || existing) {
      outcomes.push(existing ? existingSpeakerOutcome(row.rowNumber, email, existing) : {
        rowNumber: row.rowNumber,
        status: "duplicate",
        code: "DUPLICATE_EMAIL",
        message: "This email appears more than once in the import.",
        normalizedEmail: email,
        speakerId: null,
        linkedAccount: false,
      });
      continue;
    }
    seenEmails.add(email);

    const account = existingAccounts.get(email);
    if (account) {
      outcomes.push(accountOutcome(row.rowNumber, email, account));
      continue;
    }

    const speakerId = crypto.randomUUID();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const statement = database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility,
      workflow_status, revision, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, 'incomplete', 'missing', 'private',
      'invited', 1, ?)`
    ).bind(
      speakerId, eventId, `${safeSlug(value.name)}-${speakerId.slice(0, 8)}`,
      value.name, value.title, value.company, value.bio, email, initials(value.name), now,
    );
    try {
      await statement.run();
      outcomes.push({
        rowNumber: row.rowNumber,
        status: "created",
        code: "CREATED",
        message: "Speaker created as an unclaimed event profile.",
        normalizedEmail: email,
        speakerId,
        linkedAccount: false,
      });
    } catch {
      const raced = await duplicateOutcome(database, eventId, row.rowNumber, email);
      if (raced) outcomes.push(raced);
      else outcomes.push({
        rowNumber: row.rowNumber,
        status: "failed",
        code: "CREATE_FAILED",
        message: "The speaker could not be created. No data from this row was saved.",
        normalizedEmail: email,
        speakerId: null,
        linkedAccount: false,
      });
    }
  }

  const response = {
    summary: {
      created: outcomes.filter((row) => row.status === "created").length,
      duplicate: outcomes.filter((row) => row.status === "duplicate").length,
      invalid: outcomes.filter((row) => row.status === "invalid").length,
      conflict: outcomes.filter((row) => row.status === "conflict").length,
      failed: outcomes.filter((row) => row.status === "failed").length,
    },
    rows: outcomes,
  };
  return speakerRosterIngestResponseSchema.parse(response);
}
