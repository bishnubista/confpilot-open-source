import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  derivePasswordHash,
  randomPasswordSalt,
} from "../src/password.ts";

const MAX_INPUT_BYTES = 16 * 1024;
const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const REQUIRED_MIGRATION = "0025_release_review_guards.sql";

/**
 * Roles this helper may grant.
 *
 * `speaker` is deliberately absent even though `event_memberships.role` accepts
 * it. A speaker's workspace resolves through a `speakers` row keyed to their
 * user id, and only CFP registration creates that row. Granting the membership
 * alone would produce an account that signs in successfully and then finds an
 * empty portal. Speakers arrive by submitting a proposal, not by provisioning.
 *
 * An unknown value is rejected here rather than relying on the database to
 * reject it after an artifact has already been written.
 */
export const PROVISIONABLE_ROLES = ["organizer", "reviewer"];

export class ProvisionMemberError extends Error {}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function operationalPath(apiRoot, value, label) {
  if (!value || isAbsolute(value)) {
    throw new ProvisionMemberError(`${label} must be a relative path under an ignored .wrangler or .codex directory.`);
  }
  const repoRoot = resolve(apiRoot, "../..");
  const resolved = resolve(apiRoot, value);
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  if (!allowedRoots.some((root) => isWithin(resolved, root))) {
    throw new ProvisionMemberError(`${label} must remain under an ignored .wrangler or .codex directory.`);
  }
  return resolved;
}

function verifyIgnoredCredentialPaths(apiRoot, paths) {
  try {
    const insideWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: apiRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (insideWorkTree !== "true") throw new Error("not a work tree");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ProvisionMemberError("Git is required to verify that credential inputs and outputs are ignored.");
    }
    throw new ProvisionMemberError(
      "Credential artifacts must be prepared from a Git checkout so ignore coverage can be verified.",
    );
  }

  for (const { label, path } of paths) {
    try {
      execFileSync("git", ["check-ignore", "--quiet", "--", relative(apiRoot, path)], {
        cwd: apiRoot,
        stdio: "ignore",
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new ProvisionMemberError("Git is required to verify that credential inputs and outputs are ignored.");
      }
      if (error?.status === 1) {
        throw new ProvisionMemberError(
          `${label} must be ignored by Git before credential data is read or written.`,
        );
      }
      throw new ProvisionMemberError(
        "Git could not verify credential path ignore coverage; refusing to read or write credential data.",
      );
    }
  }
}

function sqlLiteral(value) {
  if (value.includes("\0")) throw new ProvisionMemberError("Input text cannot contain null bytes.");
  return `'${value.replaceAll("'", "''")}'`;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new ProvisionMemberError(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0
    || value.length > maximum || value.includes("\0")) {
    throw new ProvisionMemberError(`${label} must be normalized text no longer than ${maximum} characters.`);
  }
  return value;
}

async function ensureDirectoryWithoutSymlink(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProvisionMemberError("Output directory must not escape through a symbolic link.");
  }
}

async function rejectExistingOutputSymlinks(apiRoot, outputPath) {
  const repoRoot = resolve(apiRoot, "../..");
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  const allowedRoot = allowedRoots.find((root) => isWithin(outputPath, root));
  let currentDirectory = allowedRoot;
  const parentSegments = relative(allowedRoot, dirname(outputPath)).split(sep).filter(Boolean);
  for (const segment of [null, ...parentSegments]) {
    if (segment) currentDirectory = resolve(currentDirectory, segment);
    let metadata;
    try {
      metadata = await lstat(currentDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new ProvisionMemberError("Output directory could not be safely inspected.");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProvisionMemberError("Output directory must not escape through a symbolic link.");
    }
  }
}

async function prepareOutputDirectory(apiRoot, outputPath) {
  const repoRoot = resolve(apiRoot, "../..");
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  const allowedRoot = allowedRoots.find((root) => isWithin(outputPath, root));
  if (!allowedRoot) throw new ProvisionMemberError("Output path is outside the approved ignored directories.");

  await ensureDirectoryWithoutSymlink(allowedRoot);
  const realRoot = await realpath(allowedRoot);
  let currentDirectory = allowedRoot;
  const parentSegments = relative(allowedRoot, dirname(outputPath)).split(sep).filter(Boolean);
  for (const segment of parentSegments) {
    currentDirectory = resolve(currentDirectory, segment);
    await ensureDirectoryWithoutSymlink(currentDirectory);
    if (!isWithin(await realpath(currentDirectory), realRoot)) {
      throw new ProvisionMemberError("Output directory must not escape through a symbolic link.");
    }
  }
}

function strongPassword(value) {
  return typeof value === "string" && value.length >= 16 && value.length <= 128
    && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}

/**
 * Input shape:
 *
 *   { eventSlug, role, member: { displayName, email, password } }
 *
 * This helper exists because seeding demo data and provisioning a usable account
 * are separate operations. The bootstrap generator requires an empty database, so
 * it cannot add an account to an instance that already has data. This one can,
 * because its precondition is the opposite: the event must already exist.
 */
function normalizeInput(value) {
  exactObject(value, ["eventSlug", "member", "role"], "Member provisioning input");
  exactObject(value.member, ["displayName", "email", "password"], "Member");

  if (!PROVISIONABLE_ROLES.includes(value.role)) {
    throw new ProvisionMemberError(`Role must be one of: ${PROVISIONABLE_ROLES.join(", ")}.`);
  }

  const eventSlug = boundedText(value.eventSlug, "Event slug", 128);
  if (!EVENT_SLUG.test(eventSlug)) {
    throw new ProvisionMemberError("Event slug must be a normalized lowercase slug.");
  }
  const email = boundedText(value.member.email, "Member email", 254);
  if (email !== email.toLowerCase() || !EMAIL.test(email)) {
    throw new ProvisionMemberError("Member email must be a normalized lowercase email address.");
  }
  const member = {
    email,
    displayName: boundedText(value.member.displayName, "Member display name", 160),
    password: value.member.password,
  };
  if (!strongPassword(member.password)) {
    throw new ProvisionMemberError(
      "Member password must be 16-128 characters and include upper, lower, numeric, and symbol characters.",
    );
  }
  return { eventSlug, role: value.role, member };
}

async function readInput(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new ProvisionMemberError("Member input could not be read.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ProvisionMemberError("Member input must be a regular file.");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new ProvisionMemberError("Member input must have mode 0600.");
  }
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new ProvisionMemberError("Member input size is invalid.");
  }
  try {
    return normalizeInput(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof ProvisionMemberError) throw error;
    throw new ProvisionMemberError("Member input must be valid JSON.");
  }
}

function memberSql({ eventSlug, role, member, ids, salt, hash, createdAt }) {
  const preconditions = [
    `(SELECT COUNT(*) FROM "events" WHERE "slug" = ${sqlLiteral(eventSlug)}) = 1`,
    `(SELECT COUNT(*) FROM "d1_migrations" WHERE "name" = ${sqlLiteral(REQUIRED_MIGRATION)}) = 1`,
    `(SELECT COUNT(*) FROM "users" WHERE lower(trim("email")) = ${sqlLiteral(member.email)}) = 0`,
    `(SELECT COUNT(*) FROM "users" WHERE "id" = ${sqlLiteral(ids.user)}) = 0`,
    `(SELECT COUNT(*) FROM "event_memberships" WHERE "id" = ${sqlLiteral(ids.membership)}) = 0`,
  ].join("\n    AND ");

  return `-- The NOT NULL display_name is the first mutation gate. If any precondition is
-- false, this first statement aborts before a user, credential, or membership exists.
INSERT INTO "users" ("id", "email", "display_name", "created_at") VALUES (
  ${sqlLiteral(ids.user)}, ${sqlLiteral(member.email)},
  CASE WHEN ${preconditions} THEN ${sqlLiteral(member.displayName)} ELSE NULL END,
  ${sqlLiteral(createdAt)}
);

INSERT INTO "user_credentials" (
  "user_id", "password_salt", "password_hash", "algorithm", "iterations", "created_at", "updated_at"
) VALUES (
  ${sqlLiteral(ids.user)}, ${sqlLiteral(salt)}, ${sqlLiteral(hash)}, ${sqlLiteral(PASSWORD_ALGORITHM)},
  ${PASSWORD_ITERATIONS}, ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)}
);

INSERT INTO "event_memberships" ("id", "event_id", "user_id", "role", "created_at")
SELECT ${sqlLiteral(ids.membership)}, "id", ${sqlLiteral(ids.user)}, ${sqlLiteral(role)}, ${sqlLiteral(createdAt)}
FROM "events" WHERE "slug" = ${sqlLiteral(eventSlug)};

CREATE TABLE "_confpilot_member_guard" (
  "ok" integer NOT NULL CHECK ("ok" = 1)
);

INSERT INTO "_confpilot_member_guard" ("ok")
SELECT CASE WHEN
  (SELECT COUNT(*) FROM "users" WHERE "id" = ${sqlLiteral(ids.user)}
    AND lower(trim("email")) = ${sqlLiteral(member.email)}) = 1
  AND (SELECT COUNT(*) FROM "user_credentials" WHERE "user_id" = ${sqlLiteral(ids.user)}
    AND "algorithm" = ${sqlLiteral(PASSWORD_ALGORITHM)} AND "iterations" = ${PASSWORD_ITERATIONS}) = 1
  AND (SELECT COUNT(*) FROM "event_memberships" AS membership
    INNER JOIN "events" AS event ON event."id" = membership."event_id"
    WHERE membership."id" = ${sqlLiteral(ids.membership)}
      AND membership."user_id" = ${sqlLiteral(ids.user)}
      AND membership."role" = ${sqlLiteral(role)}
      AND event."slug" = ${sqlLiteral(eventSlug)}) = 1
THEN 1 ELSE 0 END;

DROP TABLE "_confpilot_member_guard";
`;
}

export async function prepareMemberProvisioning({ apiRoot, input, output }) {
  if (PASSWORD_ALGORITHM !== "pbkdf2-sha256" || PASSWORD_ITERATIONS !== 100_000) {
    throw new ProvisionMemberError("The imported Worker password policy is not supported by this helper.");
  }
  const inputPath = operationalPath(apiRoot, input, "Input");
  const outputPath = operationalPath(apiRoot, output, "Output");
  if (inputPath === outputPath) throw new ProvisionMemberError("Input and output paths must be different.");
  await rejectExistingOutputSymlinks(apiRoot, outputPath);
  verifyIgnoredCredentialPaths(apiRoot, [
    { label: "Input", path: inputPath },
    { label: "Output", path: outputPath },
  ]);
  const normalized = await readInput(inputPath);
  const ids = { user: crypto.randomUUID(), membership: crypto.randomUUID() };
  const salt = randomPasswordSalt();
  const hash = await derivePasswordHash(normalized.member.password, salt, PASSWORD_ITERATIONS);
  const sql = memberSql({
    ...normalized,
    ids,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  });

  await prepareOutputDirectory(apiRoot, outputPath);
  try {
    await writeFile(outputPath, sql, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new ProvisionMemberError("Member artifact already exists; refusing to overwrite.");
    }
    throw new ProvisionMemberError("Member artifact could not be written.");
  }
  const outputMetadata = await stat(outputPath);
  if ((outputMetadata.mode & 0o777) !== 0o600) {
    throw new ProvisionMemberError("Member artifact mode is not 0600.");
  }
  return {
    eventSlug: normalized.eventSlug,
    role: normalized.role,
    output: relative(apiRoot, outputPath),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (index === 0 && flag === "--") continue;
    if (!["--input", "--output"].includes(flag)) {
      throw new ProvisionMemberError("Unknown argument. Use the documented named options.");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ProvisionMemberError(`Missing value for ${flag}.`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.input || !options.output) {
    throw new ProvisionMemberError("Usage: provision-member --input <ignored-json> --output <ignored-sql>");
  }
  return options;
}

export async function runProvisionMemberCli({ apiRoot, argv, log }) {
  const result = await prepareMemberProvisioning({ apiRoot, ...parseArguments(argv) });
  log(`Prepared a provisioning artifact granting the ${result.role} role on event ${result.eventSlug}.`);
  log("Member artifact created with mode 0600 in the approved ignored directory.");
  log("No database command was executed. Inspect the artifact before applying it once.");
}

async function main() {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runProvisionMemberCli({ apiRoot, argv: process.argv.slice(2), log: console.log });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof ProvisionMemberError ? error.message : "Member artifact preparation failed.");
    process.exitCode = 1;
  });
}
