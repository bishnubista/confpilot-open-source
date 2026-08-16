import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  derivePasswordHash,
  randomPasswordSalt,
} from "../src/password.ts";

const ROLES = ["organizer", "reviewer"];
const EMAIL_PARTS = /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9.-]+)$/;
const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SECRET_FILE_BYTES = 64 * 1024;

class PreviewCredentialPreparationError extends Error {}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function operationalPath(apiRoot, value, label) {
  if (!value || isAbsolute(value)) {
    throw new PreviewCredentialPreparationError(`${label} must be a relative path under an ignored .wrangler or .codex directory.`);
  }
  const repoRoot = resolve(apiRoot, "../..");
  const resolved = resolve(apiRoot, value);
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  if (!allowedRoots.some((root) => isWithin(resolved, root))) {
    throw new PreviewCredentialPreparationError(`${label} must remain under an ignored .wrangler or .codex directory.`);
  }
  return resolved;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function strongPassword(value) {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 128
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /[0-9]/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}

function normalizeAccounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, "accounts")
    || !Array.isArray(value.accounts) || value.accounts.length !== 2) {
    throw new PreviewCredentialPreparationError("Credential input must contain exactly two accounts.");
  }

  const accounts = value.accounts.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)
      || Object.keys(account).sort().join(",") !== "email,password,role") {
      throw new PreviewCredentialPreparationError("Each account must contain only role, email, and password.");
    }
    if (!ROLES.includes(account.role)) throw new PreviewCredentialPreparationError("Accounts must use the organizer and reviewer roles.");
    if (typeof account.email !== "string") throw new PreviewCredentialPreparationError("Account emails must be strings.");
    const email = account.email.trim().toLowerCase();
    if (account.email !== email) {
      throw new PreviewCredentialPreparationError("Account emails must already be normalized lowercase values without surrounding whitespace.");
    }
    const emailParts = EMAIL_PARTS.exec(email);
    const domain = emailParts?.[2];
    if (email.length > 254 || !domain
      || !(domain === "example.com" || domain === "example.org" || domain === "example.net" || domain.endsWith(".example"))) {
      throw new PreviewCredentialPreparationError("Account emails must use the reserved example namespace.");
    }
    if (!strongPassword(account.password)) {
      throw new PreviewCredentialPreparationError("Passwords must be 16-128 characters and include upper, lower, numeric, and symbol characters.");
    }
    return { role: account.role, email, password: account.password };
  }).sort((left, right) => ROLES.indexOf(left.role) - ROLES.indexOf(right.role));

  if (accounts.map(({ role }) => role).join(",") !== ROLES.join(",")) {
    throw new PreviewCredentialPreparationError("Credential input must contain one organizer and one reviewer.");
  }
  if (accounts[0].email === accounts[1].email) throw new PreviewCredentialPreparationError("Account emails must be distinct.");
  if (accounts[0].password === accounts[1].password) throw new PreviewCredentialPreparationError("Account passwords must be distinct.");
  return accounts;
}

async function readCredentialInput(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new PreviewCredentialPreparationError("Credential input could not be read.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new PreviewCredentialPreparationError("Credential input must be a regular file.");
  if ((metadata.mode & 0o777) !== 0o600) throw new PreviewCredentialPreparationError("Credential input must have mode 0600.");
  if (metadata.size <= 0 || metadata.size > MAX_SECRET_FILE_BYTES) {
    throw new PreviewCredentialPreparationError("Credential input size is invalid.");
  }
  let decoded;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new PreviewCredentialPreparationError("Credential input must be valid JSON.");
  }
  return normalizeAccounts(decoded);
}

function credentialSql(eventSlug, accounts) {
  const values = accounts.map((account) =>
    `  (${sqlLiteral(account.role)}, ${sqlLiteral(account.email)}, ${sqlLiteral(account.salt)}, ${sqlLiteral(account.hash)})`)
    .join(",\n");
  const event = sqlLiteral(eventSlug);
  const targets = `WITH "credential_targets" (
  "role", "email", "password_salt", "password_hash"
) AS (VALUES
${values}
)`;
  return `PRAGMA foreign_keys = ON;

CREATE TABLE "_confpilot_preview_credential_guard" (
  "ok" integer NOT NULL CHECK ("ok" = 1)
);

${targets}
INSERT INTO "_confpilot_preview_credential_guard" ("ok")
SELECT CASE WHEN
  (SELECT COUNT(*) FROM "credential_targets") = 2
  AND (SELECT COUNT(*) FROM "events" WHERE "slug" = ${event}) = 1
  AND (SELECT COUNT(*) FROM "user_credentials"
    WHERE "algorithm" = 'pbkdf2-sha256' AND "iterations" = 600000) = 2
  AND NOT EXISTS (
    SELECT 1 FROM "credential_targets" AS target
    WHERE (
      SELECT COUNT(*)
      FROM "users" AS user
      INNER JOIN "user_credentials" AS credential ON credential."user_id" = user."id"
      WHERE lower(trim(user."email")) = target."email"
        AND credential."algorithm" = 'pbkdf2-sha256'
        AND credential."iterations" = 600000
        AND credential."password_salt" <> target."password_salt"
        AND credential."password_hash" <> target."password_hash"
    ) <> 1
    OR (
      SELECT COUNT(*)
      FROM "users" AS user
      INNER JOIN "event_memberships" AS membership ON membership."user_id" = user."id"
      INNER JOIN "events" AS event ON event."id" = membership."event_id"
      WHERE lower(trim(user."email")) = target."email"
        AND event."slug" = ${event}
        AND membership."role" = target."role"
    ) <> 1
  )
THEN 1 ELSE 0 END;

${targets}
UPDATE "auth_sessions"
SET "revoked_at" = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE "revoked_at" IS NULL
  AND "user_id" IN (
    SELECT user."id"
    FROM "users" AS user
    INNER JOIN "credential_targets" AS target
      ON target."email" = lower(trim(user."email"))
    INNER JOIN "event_memberships" AS membership
      ON membership."user_id" = user."id" AND membership."role" = target."role"
    INNER JOIN "events" AS event
      ON event."id" = membership."event_id" AND event."slug" = ${event}
  );

${targets}
INSERT INTO "_confpilot_preview_credential_guard" ("ok")
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM "auth_sessions" AS session
  INNER JOIN "users" AS user ON user."id" = session."user_id"
  INNER JOIN "credential_targets" AS target
    ON target."email" = lower(trim(user."email"))
  WHERE session."revoked_at" IS NULL
) THEN 1 ELSE 0 END;

${targets}
UPDATE "user_credentials"
SET "password_salt" = (
      SELECT target."password_salt"
      FROM "credential_targets" AS target
      INNER JOIN "users" AS user ON lower(trim(user."email")) = target."email"
      WHERE user."id" = "user_credentials"."user_id"
    ),
    "password_hash" = (
      SELECT target."password_hash"
      FROM "credential_targets" AS target
      INNER JOIN "users" AS user ON lower(trim(user."email")) = target."email"
      WHERE user."id" = "user_credentials"."user_id"
    ),
    "algorithm" = 'pbkdf2-sha256',
    "iterations" = ${PASSWORD_ITERATIONS},
    "updated_at" = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE "user_id" IN (
  SELECT user."id"
  FROM "users" AS user
  INNER JOIN "credential_targets" AS target
    ON target."email" = lower(trim(user."email"))
)
AND (SELECT COUNT(*) FROM "user_credentials"
  WHERE "algorithm" = 'pbkdf2-sha256' AND "iterations" = 600000) = 2
AND NOT EXISTS (
  SELECT 1 FROM "credential_targets" AS target
  WHERE (
    SELECT COUNT(*)
    FROM "users" AS user
    INNER JOIN "user_credentials" AS credential ON credential."user_id" = user."id"
    WHERE lower(trim(user."email")) = target."email"
      AND credential."algorithm" = 'pbkdf2-sha256'
      AND credential."iterations" = 600000
      AND credential."password_salt" <> target."password_salt"
      AND credential."password_hash" <> target."password_hash"
  ) <> 1
  OR (
    SELECT COUNT(*)
    FROM "users" AS user
    INNER JOIN "event_memberships" AS membership ON membership."user_id" = user."id"
    INNER JOIN "events" AS event ON event."id" = membership."event_id"
    WHERE lower(trim(user."email")) = target."email"
      AND event."slug" = ${event}
      AND membership."role" = target."role"
  ) <> 1
)
AND NOT EXISTS (
  SELECT 1 FROM "auth_sessions" AS session
  INNER JOIN "users" AS user ON user."id" = session."user_id"
  INNER JOIN "credential_targets" AS target
    ON target."email" = lower(trim(user."email"))
  WHERE session."revoked_at" IS NULL
);

${targets}
INSERT INTO "_confpilot_preview_credential_guard" ("ok")
SELECT CASE WHEN changes() = 2
  AND NOT EXISTS (
    SELECT 1 FROM "credential_targets" AS target
    WHERE (
      SELECT COUNT(*)
      FROM "users" AS user
      INNER JOIN "user_credentials" AS credential ON credential."user_id" = user."id"
      WHERE lower(trim(user."email")) = target."email"
        AND credential."algorithm" = 'pbkdf2-sha256'
        AND credential."iterations" = ${PASSWORD_ITERATIONS}
        AND credential."password_salt" = target."password_salt"
        AND credential."password_hash" = target."password_hash"
    ) <> 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM "auth_sessions" AS session
    INNER JOIN "users" AS user ON user."id" = session."user_id"
    INNER JOIN "credential_targets" AS target
      ON target."email" = lower(trim(user."email"))
    WHERE session."revoked_at" IS NULL
  )
THEN 1 ELSE 0 END;

DROP TABLE "_confpilot_preview_credential_guard";
`;
}

export async function preparePreviewCredentials({ apiRoot, input, eventSlug, output }) {
  if (PASSWORD_ALGORITHM !== "pbkdf2-sha256" || PASSWORD_ITERATIONS !== 100_000) {
    throw new PreviewCredentialPreparationError("The imported Worker password policy is not supported by this helper.");
  }
  if (typeof eventSlug !== "string" || eventSlug.length > 128 || !EVENT_SLUG.test(eventSlug)) {
    throw new PreviewCredentialPreparationError("Event slug must be a normalized lowercase slug.");
  }
  const inputPath = operationalPath(apiRoot, input, "Input");
  const outputPath = operationalPath(apiRoot, output, "Output");
  if (inputPath === outputPath) throw new PreviewCredentialPreparationError("Input and output paths must be different.");
  const accounts = await readCredentialInput(inputPath);

  const salts = new Set();
  const materials = [];
  for (const account of accounts) {
    let salt = randomPasswordSalt();
    while (salts.has(salt)) salt = randomPasswordSalt();
    salts.add(salt);
    materials.push({
      role: account.role,
      email: account.email,
      salt,
      hash: await derivePasswordHash(account.password, salt, PASSWORD_ITERATIONS),
    });
  }

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, credentialSql(eventSlug, materials), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new PreviewCredentialPreparationError("Credential artifact already exists; refusing to overwrite.");
    }
    throw new PreviewCredentialPreparationError("Credential artifact could not be written.");
  }
  const outputMetadata = await stat(outputPath);
  if ((outputMetadata.mode & 0o777) !== 0o600) throw new PreviewCredentialPreparationError("Credential artifact mode is not 0600.");
  return { accountCount: materials.length, output: relative(apiRoot, outputPath) };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--input", "--event-slug", "--output"].includes(flag)) throw new PreviewCredentialPreparationError("Unknown argument. Use the documented named options.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new PreviewCredentialPreparationError(`Missing value for ${flag}.`);
    options[flag === "--event-slug" ? "eventSlug" : flag.slice(2)] = value;
    index += 1;
  }
  if (!options.input || !options.eventSlug || !options.output) {
    throw new PreviewCredentialPreparationError("Usage: prepare-preview-credentials --input <ignored-json> --event-slug <slug> --output <ignored-sql>");
  }
  return options;
}

export async function runPreviewCredentialCli({ apiRoot, argv, log }) {
  const result = await preparePreviewCredentials({ apiRoot, ...parseArguments(argv) });
  log(`Prepared credential updates for ${result.accountCount} required preview roles.`);
  log("Credential artifact created with mode 0600 in the approved ignored directory.");
  log("No database command was executed. Verify the target event and capture a Time Travel bookmark before applying this file once.");
}

async function main() {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runPreviewCredentialCli({ apiRoot, argv: process.argv.slice(2), log: console.log });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof PreviewCredentialPreparationError
      ? error.message
      : "Credential artifact preparation failed.");
    process.exitCode = 1;
  });
}
