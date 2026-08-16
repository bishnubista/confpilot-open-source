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

const MAX_INPUT_BYTES = 64 * 1024;
const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const REQUIRED_MIGRATION = "0025_release_review_guards.sql";

export class BootstrapInstanceError extends Error {}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function operationalPath(apiRoot, value, label) {
  if (!value || isAbsolute(value)) {
    throw new BootstrapInstanceError(`${label} must be a relative path under an ignored .wrangler or .codex directory.`);
  }
  const repoRoot = resolve(apiRoot, "../..");
  const resolved = resolve(apiRoot, value);
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  if (!allowedRoots.some((root) => isWithin(resolved, root))) {
    throw new BootstrapInstanceError(`${label} must remain under an ignored .wrangler or .codex directory.`);
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
      throw new BootstrapInstanceError("Git is required to verify that credential inputs and outputs are ignored.");
    }
    throw new BootstrapInstanceError(
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
        throw new BootstrapInstanceError("Git is required to verify that credential inputs and outputs are ignored.");
      }
      if (error?.status === 1) {
        throw new BootstrapInstanceError(
          `${label} must be ignored by Git before credential data is read or written.`,
        );
      }
      throw new BootstrapInstanceError(
        "Git could not verify credential path ignore coverage; refusing to read or write credential data.",
      );
    }
  }
}

function sqlLiteral(value) {
  if (value.includes("\0")) throw new BootstrapInstanceError("Input text cannot contain null bytes.");
  return `'${value.replaceAll("'", "''")}'`;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new BootstrapInstanceError(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
}

function boundedText(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value !== value.trim()
    || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\0")) {
    throw new BootstrapInstanceError(`${label} must be normalized text no longer than ${maximum} characters.`);
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
    throw new BootstrapInstanceError("Output directory must not escape through a symbolic link.");
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
      throw new BootstrapInstanceError("Output directory could not be safely inspected.");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new BootstrapInstanceError("Output directory must not escape through a symbolic link.");
    }
  }
}

async function prepareOutputDirectory(apiRoot, outputPath) {
  const repoRoot = resolve(apiRoot, "../..");
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  const allowedRoot = allowedRoots.find((root) => isWithin(outputPath, root));
  if (!allowedRoot) throw new BootstrapInstanceError("Output path is outside the approved ignored directories.");

  await ensureDirectoryWithoutSymlink(allowedRoot);
  const realRoot = await realpath(allowedRoot);
  let currentDirectory = allowedRoot;
  const parentSegments = relative(allowedRoot, dirname(outputPath)).split(sep).filter(Boolean);
  for (const segment of parentSegments) {
    currentDirectory = resolve(currentDirectory, segment);
    await ensureDirectoryWithoutSymlink(currentDirectory);
    if (!isWithin(await realpath(currentDirectory), realRoot)) {
      throw new BootstrapInstanceError("Output directory must not escape through a symbolic link.");
    }
  }
}

function validDate(value) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validInstant(value) {
  return INSTANT.test(value) && !Number.isNaN(new Date(value).valueOf())
    && new Date(value).toISOString() === value.replace("Z", ".000Z");
}

function strongPassword(value) {
  return typeof value === "string" && value.length >= 16 && value.length <= 128
    && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}

function normalizeInput(value) {
  exactObject(value, ["event", "owner"], "Bootstrap input");
  exactObject(value.event, [
    "cfpClosesAt", "cfpOpensAt", "description", "endsOn", "location", "name",
    "slug", "startsOn", "tagline", "timeZone",
  ], "Event");
  exactObject(value.owner, ["displayName", "email", "password"], "Owner");

  const event = {
    slug: boundedText(value.event.slug, "Event slug", 128),
    name: boundedText(value.event.name, "Event name", 160),
    tagline: boundedText(value.event.tagline, "Event tagline", 240, { allowEmpty: true }),
    location: boundedText(value.event.location, "Event location", 240),
    description: boundedText(value.event.description, "Event description", 4_000, { allowEmpty: true }),
    startsOn: value.event.startsOn,
    endsOn: value.event.endsOn,
    cfpOpensAt: value.event.cfpOpensAt,
    cfpClosesAt: value.event.cfpClosesAt,
    timeZone: boundedText(value.event.timeZone, "Event time zone", 64),
  };
  if (!EVENT_SLUG.test(event.slug)) throw new BootstrapInstanceError("Event slug must be a normalized lowercase slug.");
  if (!validDate(event.startsOn) || !validDate(event.endsOn) || event.startsOn > event.endsOn) {
    throw new BootstrapInstanceError("Event dates must be real YYYY-MM-DD values with startsOn no later than endsOn.");
  }
  if (!validInstant(event.cfpOpensAt) || !validInstant(event.cfpClosesAt)
    || event.cfpOpensAt >= event.cfpClosesAt
    || event.cfpClosesAt.slice(0, 10) > event.startsOn) {
    throw new BootstrapInstanceError("CFP instants must be canonical second-precision UTC values, open before close, and close no later than the event start date.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: event.timeZone }).format();
  } catch {
    throw new BootstrapInstanceError("Event time zone must be a supported IANA time zone.");
  }

  const email = boundedText(value.owner.email, "Owner email", 254);
  if (email !== email.toLowerCase() || !EMAIL.test(email)) {
    throw new BootstrapInstanceError("Owner email must be a normalized lowercase email address.");
  }
  const owner = {
    email,
    displayName: boundedText(value.owner.displayName, "Owner display name", 160),
    password: value.owner.password,
  };
  if (!strongPassword(owner.password)) {
    throw new BootstrapInstanceError("Owner password must be 16-128 characters and include upper, lower, numeric, and symbol characters.");
  }
  return { event, owner };
}

async function readInput(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new BootstrapInstanceError("Bootstrap input could not be read.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new BootstrapInstanceError("Bootstrap input must be a regular file.");
  if ((metadata.mode & 0o777) !== 0o600) throw new BootstrapInstanceError("Bootstrap input must have mode 0600.");
  if (metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) throw new BootstrapInstanceError("Bootstrap input size is invalid.");
  try {
    return normalizeInput(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof BootstrapInstanceError) throw error;
    throw new BootstrapInstanceError("Bootstrap input must be valid JSON.");
  }
}

function bootstrapSql({ event, owner, ids, salt, hash, createdAt }) {
  const fields = [
    [ids.titleField, "title", "session", "short_text", "Title", "Make it clear and specific.", "[]", 10],
    [ids.abstractField, "abstract", "session", "long_text", "Abstract", "Describe what attendees will learn.", "[]", 20],
    [ids.trackField, "track", "session", "dropdown", "Track", "", '[{"value":"General","label":"General"}]', 30],
    [ids.formatField, "format", "session", "dropdown", "Format", "", '[{"value":"talk","label":"Talk (30 min)","durationMinutes":30}]', 40],
  ];
  const fieldValues = fields.map((field) => {
    const values = field.map((item) => typeof item === "number" ? item : sqlLiteral(item));
    return `  (${values.join(", ")}, ${sqlLiteral(ids.event)}, 1, NULL, NULL, 1)`;
  }).join(",\n");
  const emptyTables = ["events", "users", "user_credentials", "event_memberships", "cfp_configs", "cfp_fields"];
  const emptyCheck = [
    ...emptyTables.map((table) => `(SELECT COUNT(*) FROM "${table}") = 0`),
    `(SELECT COUNT(*) FROM "d1_migrations" WHERE "name" = ${sqlLiteral(REQUIRED_MIGRATION)}) = 1`,
  ].join("\n  AND ");
  return `INSERT INTO "events" (
  "id", "slug", "name", "tagline", "location", "description", "starts_on", "ends_on",
  "cfp_deadline", "status", "time_zone"
) VALUES (
  ${sqlLiteral(ids.event)}, ${sqlLiteral(event.slug)}, ${sqlLiteral(event.name)}, ${sqlLiteral(event.tagline)},
  ${sqlLiteral(event.location)}, ${sqlLiteral(event.description)}, ${sqlLiteral(event.startsOn)}, ${sqlLiteral(event.endsOn)},
  ${sqlLiteral(event.cfpClosesAt)},
  CASE WHEN ${emptyCheck} THEN 'published' ELSE NULL END,
  ${sqlLiteral(event.timeZone)}
);

INSERT INTO "users" ("id", "email", "display_name", "created_at") VALUES
  (${sqlLiteral(ids.owner)}, ${sqlLiteral(owner.email)}, ${sqlLiteral(owner.displayName)}, ${sqlLiteral(createdAt)});

INSERT INTO "user_credentials" (
  "user_id", "password_salt", "password_hash", "algorithm", "iterations", "created_at", "updated_at"
) VALUES (
  ${sqlLiteral(ids.owner)}, ${sqlLiteral(salt)}, ${sqlLiteral(hash)}, ${sqlLiteral(PASSWORD_ALGORITHM)},
  ${PASSWORD_ITERATIONS}, ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)}
);

INSERT INTO "event_memberships" ("id", "event_id", "user_id", "role", "created_at") VALUES
  (${sqlLiteral(ids.membership)}, ${sqlLiteral(ids.event)}, ${sqlLiteral(ids.owner)}, 'organizer', ${sqlLiteral(createdAt)});

INSERT INTO "cfp_configs" (
  "event_id", "status", "opens_at", "closes_at", "confirmation_message", "revision", "created_at", "updated_at"
) VALUES (
  ${sqlLiteral(ids.event)}, 'published', ${sqlLiteral(event.cfpOpensAt)}, ${sqlLiteral(event.cfpClosesAt)},
  'Thanks for sharing your proposal. You can view its status from this account.', 1,
  ${sqlLiteral(createdAt)}, ${sqlLiteral(createdAt)}
);

INSERT INTO "cfp_fields" (
  "id", "field_key", "section", "field_type", "label", "help_text", "options_json", "sort_order",
  "event_id", "required", "show_when_field_key", "show_when_value", "active"
) VALUES
${fieldValues};

CREATE TABLE "_confpilot_bootstrap_guard" (
  "ok" integer NOT NULL CHECK ("ok" = 1)
);

INSERT INTO "_confpilot_bootstrap_guard" ("ok")
SELECT CASE WHEN
  (SELECT COUNT(*) FROM "events" WHERE "id" = ${sqlLiteral(ids.event)} AND "slug" = ${sqlLiteral(event.slug)}) = 1
  AND (SELECT COUNT(*) FROM "users" WHERE "id" = ${sqlLiteral(ids.owner)} AND "email" = ${sqlLiteral(owner.email)}) = 1
  AND (SELECT COUNT(*) FROM "user_credentials" WHERE "user_id" = ${sqlLiteral(ids.owner)}
    AND "algorithm" = ${sqlLiteral(PASSWORD_ALGORITHM)} AND "iterations" = ${PASSWORD_ITERATIONS}) = 1
  AND (SELECT COUNT(*) FROM "event_memberships" WHERE "event_id" = ${sqlLiteral(ids.event)}
    AND "user_id" = ${sqlLiteral(ids.owner)} AND "role" = 'organizer') = 1
  AND (SELECT COUNT(*) FROM "cfp_configs" WHERE "event_id" = ${sqlLiteral(ids.event)} AND "status" = 'published') = 1
  AND (SELECT COUNT(*) FROM "cfp_fields" WHERE "event_id" = ${sqlLiteral(ids.event)} AND "active" = 1) = 4
THEN 1 ELSE 0 END;

DROP TABLE "_confpilot_bootstrap_guard";
`;
}

export async function prepareInstanceBootstrap({ apiRoot, input, output }) {
  if (PASSWORD_ALGORITHM !== "pbkdf2-sha256" || PASSWORD_ITERATIONS !== 100_000) {
    throw new BootstrapInstanceError("The imported Worker password policy is not supported by this helper.");
  }
  const inputPath = operationalPath(apiRoot, input, "Input");
  const outputPath = operationalPath(apiRoot, output, "Output");
  if (inputPath === outputPath) throw new BootstrapInstanceError("Input and output paths must be different.");
  await rejectExistingOutputSymlinks(apiRoot, outputPath);
  verifyIgnoredCredentialPaths(apiRoot, [
    { label: "Input", path: inputPath },
    { label: "Output", path: outputPath },
  ]);
  const normalized = await readInput(inputPath);
  const ids = {
    event: crypto.randomUUID(), owner: crypto.randomUUID(), membership: crypto.randomUUID(),
    titleField: crypto.randomUUID(), abstractField: crypto.randomUUID(),
    trackField: crypto.randomUUID(), formatField: crypto.randomUUID(),
  };
  const salt = randomPasswordSalt();
  const hash = await derivePasswordHash(normalized.owner.password, salt, PASSWORD_ITERATIONS);
  const sql = bootstrapSql({ ...normalized, ids, salt, hash, createdAt: new Date().toISOString() });

  await prepareOutputDirectory(apiRoot, outputPath);
  try {
    await writeFile(outputPath, sql, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new BootstrapInstanceError("Bootstrap artifact already exists; refusing to overwrite.");
    }
    throw new BootstrapInstanceError("Bootstrap artifact could not be written.");
  }
  const outputMetadata = await stat(outputPath);
  if ((outputMetadata.mode & 0o777) !== 0o600) throw new BootstrapInstanceError("Bootstrap artifact mode is not 0600.");
  return { eventSlug: normalized.event.slug, output: relative(apiRoot, outputPath) };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (index === 0 && flag === "--") continue;
    if (!["--input", "--output"].includes(flag)) throw new BootstrapInstanceError("Unknown argument. Use the documented named options.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new BootstrapInstanceError(`Missing value for ${flag}.`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.input || !options.output) {
    throw new BootstrapInstanceError("Usage: bootstrap-instance --input <ignored-json> --output <ignored-sql>");
  }
  return options;
}

export async function runBootstrapCli({ apiRoot, argv, log }) {
  const result = await prepareInstanceBootstrap({ apiRoot, ...parseArguments(argv) });
  log(`Prepared an empty-instance bootstrap artifact for event ${result.eventSlug}.`);
  log("Bootstrap artifact created with mode 0600 in the approved ignored directory.");
  log("No database command was executed. Apply migrations to an empty database before applying this file once.");
}

async function main() {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runBootstrapCli({ apiRoot, argv: process.argv.slice(2), log: console.log });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof BootstrapInstanceError ? error.message : "Bootstrap artifact preparation failed.");
    process.exitCode = 1;
  });
}
