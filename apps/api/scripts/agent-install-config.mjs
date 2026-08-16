import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

/**
 * Generates and patches the ignored per-environment Wrangler config described in
 * docs/self-hosting/agent-install.md Sections 2-4, instead of an agent or operator
 * hand-editing JSONC. This tool only ever touches an ignored local file: it never
 * runs a Wrangler command that reads or writes a remote Cloudflare resource, and it
 * never sees TURNSTILE_SECRET_KEY (that stays interactive, per Section 4).
 *
 * It is a convenience layer in front of the existing, independently tested gate:
 * every config this tool produces is expected to pass `deploy:preflight`
 * (validate-deploy-config.mjs) unchanged. This tool does not re-implement that
 * validation and is not a substitute for running it.
 */

const MAX_PLAN_BYTES = 16 * 1024;
const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OUTPUT_FILENAME = /^wrangler\.[a-z0-9]+(?:-[a-z0-9]+)*\.local\.jsonc$/;
const RATE_LIMIT_ID = /^[1-9][0-9]*$/;
const PLACEHOLDER_RATE_LIMIT_IDS = new Set(["1001", "1002"]);
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const PLAN_KEYS = ["workerName", "d1Name", "r2Name", "rateLimitSourceId", "rateLimitAccountId", "calendarUidDomain", "sourceUrl"];

// Fixed structural literals that docs/operations/cloudflare-deployment.md and
// validate-deploy-config.mjs both already treat as required exact values for the
// ConfPilot Worker. Held here rather than read back from `unstable_readConfig`,
// which resolves `main` to an absolute local filesystem path — exactly the kind of
// value this repo's own rules forbid writing into a config an agent will read.
const FIXED_MAIN = "src/index.ts";
const FIXED_ASSETS_DIRECTORY = "../web/dist";
const FIXED_ASSETS_BINDING = "ASSETS";
const FIXED_NOT_FOUND_HANDLING = "single-page-application";
const FIXED_WORKER_FIRST_PATHS = ["/api", "/api/*", "/llms.txt"];
const FIXED_D1_BINDING = "DB";
const FIXED_R2_BINDING = "FILES";
const FIXED_RATE_LIMIT_SOURCE_NAME = "LOGIN_SOURCE_RATE_LIMITER";
const FIXED_RATE_LIMIT_ACCOUNT_NAME = "LOGIN_ACCOUNT_RATE_LIMITER";

export class AgentInstallConfigError extends Error {}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function requireGitIgnored(apiRoot, path, label) {
  try {
    const insideWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: apiRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (insideWorkTree !== "true") throw new Error("not a work tree");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AgentInstallConfigError("Git is required to verify that install artifacts are ignored.");
    }
    throw new AgentInstallConfigError(`${label} must be prepared from a Git checkout so ignore coverage can be verified.`);
  }
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", relative(apiRoot, path)], { cwd: apiRoot, stdio: "ignore" });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AgentInstallConfigError("Git is required to verify that install artifacts are ignored.");
    }
    if (error?.status === 1) {
      throw new AgentInstallConfigError(`${label} must be ignored by Git before provider identifiers are added.`);
    }
    throw new AgentInstallConfigError(`Git could not verify ${label.toLowerCase()}'s ignore coverage.`);
  }
}

function resourceName(value, label) {
  if (typeof value !== "string" || !RESOURCE_NAME.test(value)) {
    throw new AgentInstallConfigError(`${label} must be a normalized lowercase resource name.`);
  }
  return value;
}

function rateLimitId(value, label) {
  if (typeof value !== "string" || !RATE_LIMIT_ID.test(value) || PLACEHOLDER_RATE_LIMIT_IDS.has(value)) {
    throw new AgentInstallConfigError(`${label} must be a positive integer that replaces the tracked placeholder.`);
  }
  return value;
}

function httpUrl(value, label) {
  if (typeof value !== "string") throw new AgentInstallConfigError(`${label} must be an absolute HTTP(S) URL.`);
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new AgentInstallConfigError(`${label} must be an absolute HTTP(S) URL without embedded credentials.`);
  }
}

function hostname(value, label) {
  if (typeof value !== "string" || value !== value.trim() || !HOSTNAME.test(value)) {
    throw new AgentInstallConfigError(`${label} must be one normalized hostname without a scheme, port, path, or wildcard.`);
  }
  return value.toLowerCase();
}

function hostnameList(value, label) {
  const hostnames = String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => hostname(entry, `${label} entry`));
  if (hostnames.length === 0) throw new AgentInstallConfigError(`${label} must include at least one hostname.`);
  if (new Set(hostnames).size !== hostnames.length) throw new AgentInstallConfigError(`${label} entries must be unique.`);
  return hostnames;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new AgentInstallConfigError(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
}

function operationalPath(apiRoot, value, label) {
  if (!value || isAbsolute(value)) {
    throw new AgentInstallConfigError(`${label} must be a relative path under an ignored .wrangler or .codex directory.`);
  }
  const repoRoot = resolve(apiRoot, "../..");
  const resolved = resolve(apiRoot, value);
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  if (!allowedRoots.some((root) => isWithin(resolved, root))) {
    throw new AgentInstallConfigError(`${label} must remain under an ignored .wrangler or .codex directory.`);
  }
  return resolved;
}

async function readPlan(apiRoot, planArgument) {
  const path = operationalPath(apiRoot, planArgument, "Install plan");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new AgentInstallConfigError("Install plan could not be read.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AgentInstallConfigError("Install plan must be a regular file.");
  if ((metadata.mode & 0o777) !== 0o600) throw new AgentInstallConfigError("Install plan must have mode 0600.");
  if (metadata.size <= 0 || metadata.size > MAX_PLAN_BYTES) throw new AgentInstallConfigError("Install plan size is invalid.");
  requireGitIgnored(apiRoot, path, "Install plan");

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new AgentInstallConfigError("Install plan must be valid JSON.");
  }
  exactObject(parsed, PLAN_KEYS, "Install plan");
  const rateLimitSourceId = rateLimitId(parsed.rateLimitSourceId, "rateLimitSourceId");
  const rateLimitAccountId = rateLimitId(parsed.rateLimitAccountId, "rateLimitAccountId");
  if (rateLimitSourceId === rateLimitAccountId) {
    throw new AgentInstallConfigError("rateLimitSourceId and rateLimitAccountId must be distinct.");
  }
  return {
    workerName: resourceName(parsed.workerName, "workerName"),
    d1Name: resourceName(parsed.d1Name, "d1Name"),
    r2Name: resourceName(parsed.r2Name, "r2Name"),
    rateLimitSourceId,
    rateLimitAccountId,
    calendarUidDomain: hostname(parsed.calendarUidDomain, "calendarUidDomain"),
    sourceUrl: httpUrl(parsed.sourceUrl, "sourceUrl"),
  };
}

/** Read the tracked, generic wrangler.jsonc for the structural fields this tool never varies. */
function readTrackedTemplate(apiRoot) {
  const templatePath = resolve(apiRoot, "wrangler.jsonc");
  let parsed;
  try {
    parsed = unstable_readConfig({ config: templatePath }, { hideWarnings: true });
  } catch {
    throw new AgentInstallConfigError("The tracked wrangler.jsonc template could not be parsed.");
  }
  const database = (parsed.d1_databases ?? []).find((entry) => entry.binding === FIXED_D1_BINDING);
  const files = (parsed.r2_buckets ?? []).find((entry) => entry.binding === FIXED_R2_BINDING);
  const sourceLimiter = (parsed.ratelimits ?? []).find((entry) => entry.name === FIXED_RATE_LIMIT_SOURCE_NAME);
  const accountLimiter = (parsed.ratelimits ?? []).find((entry) => entry.name === FIXED_RATE_LIMIT_ACCOUNT_NAME);
  if (!database || !files || !sourceLimiter || !accountLimiter) {
    throw new AgentInstallConfigError("The tracked wrangler.jsonc template is missing an expected binding.");
  }
  return {
    main: FIXED_MAIN,
    compatibilityDate: parsed.compatibility_date,
    observability: parsed.observability,
    limits: parsed.limits,
    assetsDirectory: FIXED_ASSETS_DIRECTORY,
    assetsBinding: FIXED_ASSETS_BINDING,
    notFoundHandling: FIXED_NOT_FOUND_HANDLING,
    workerFirstPaths: FIXED_WORKER_FIRST_PATHS,
    d1Binding: database.binding,
    d1MigrationsDir: database.migrations_dir,
    r2Binding: files.binding,
    rateLimitSourceName: sourceLimiter.name,
    rateLimitSourcePolicy: sourceLimiter.simple,
    rateLimitAccountName: accountLimiter.name,
    rateLimitAccountPolicy: accountLimiter.simple,
  };
}

const STRUCTURAL_FIELD_LABELS = {
  main: "main",
  compatibilityDate: "compatibility_date",
  observability: "observability",
  limits: "limits",
  assetsDirectory: "assets.directory",
  assetsBinding: "assets.binding",
  notFoundHandling: "assets.not_found_handling",
  workerFirstPaths: "assets.run_worker_first",
  d1Binding: "d1_databases[].binding",
  d1MigrationsDir: "d1_databases[].migrations_dir",
  r2Binding: "r2_buckets[].binding",
  rateLimitSourceName: "ratelimits[source].name",
  rateLimitSourcePolicy: "ratelimits[source].simple",
  rateLimitAccountName: "ratelimits[account].name",
  rateLimitAccountPolicy: "ratelimits[account].simple",
};

const VARS_FIELD_LABELS = {
  TURNSTILE_SITE_KEY: "vars.TURNSTILE_SITE_KEY",
  TURNSTILE_ALLOWED_HOSTNAMES: "vars.TURNSTILE_ALLOWED_HOSTNAMES",
  CALENDAR_UID_DOMAIN: "vars.CALENDAR_UID_DOMAIN",
  SOURCE_URL: "vars.SOURCE_URL",
};

const ENV_FIELD_LABELS = {
  workerName: "name",
  d1Name: "d1_databases[].database_name",
  d1Id: "d1_databases[].database_id",
  r2Name: "r2_buckets[].bucket_name",
  rateLimitSourceId: "ratelimits[source].namespace_id",
  rateLimitAccountId: "ratelimits[account].namespace_id",
};

function requireDefined(value, label) {
  if (value === undefined) {
    throw new AgentInstallConfigError(`Cannot render the Wrangler config: ${label} is missing.`);
  }
  return value;
}

export function renderWranglerConfig(structural, env) {
  for (const [key, label] of Object.entries(STRUCTURAL_FIELD_LABELS)) requireDefined(structural[key], label);
  for (const [key, label] of Object.entries(ENV_FIELD_LABELS)) requireDefined(env[key], label);
  if (env.vars) {
    for (const [key, label] of Object.entries(VARS_FIELD_LABELS)) requireDefined(env.vars[key], label);
  }
  const varsBlock = env.vars
    ? `  "vars": {
    "TURNSTILE_SITE_KEY": ${JSON.stringify(env.vars.TURNSTILE_SITE_KEY)},
    "TURNSTILE_ALLOWED_HOSTNAMES": ${JSON.stringify(env.vars.TURNSTILE_ALLOWED_HOSTNAMES)},
    "CALENDAR_UID_DOMAIN": ${JSON.stringify(env.vars.CALENDAR_UID_DOMAIN)},
    "SOURCE_URL": ${JSON.stringify(env.vars.SOURCE_URL)}
  },
`
    : "";
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  // Generated by scripts/agent-install-config.mjs from wrangler.jsonc and an ignored
  // install plan (docs/self-hosting/agent-install.md, Sections 2-4). Do not hand-edit;
  // regenerate with the init/set-d1-id/set-vars subcommands.
  "name": ${JSON.stringify(env.workerName)},
  "main": ${JSON.stringify(structural.main)},
  "compatibility_date": ${JSON.stringify(structural.compatibilityDate)},
  "observability": ${JSON.stringify(structural.observability)},
  "limits": ${JSON.stringify(structural.limits)},
  "assets": {
    "directory": ${JSON.stringify(structural.assetsDirectory)},
    "binding": ${JSON.stringify(structural.assetsBinding)},
    "not_found_handling": ${JSON.stringify(structural.notFoundHandling)},
    "run_worker_first": ${JSON.stringify(structural.workerFirstPaths)}
  },
${varsBlock}  "d1_databases": [
    {
      "binding": ${JSON.stringify(structural.d1Binding)},
      "database_name": ${JSON.stringify(env.d1Name)},
      "database_id": ${JSON.stringify(env.d1Id)},
      "migrations_dir": ${JSON.stringify(structural.d1MigrationsDir)}
    }
  ],
  "r2_buckets": [
    { "binding": ${JSON.stringify(structural.r2Binding)}, "bucket_name": ${JSON.stringify(env.r2Name)} }
  ],
  "ratelimits": [
    {
      "name": ${JSON.stringify(structural.rateLimitSourceName)},
      "namespace_id": ${JSON.stringify(env.rateLimitSourceId)},
      "simple": ${JSON.stringify(structural.rateLimitSourcePolicy)}
    },
    {
      "name": ${JSON.stringify(structural.rateLimitAccountName)},
      "namespace_id": ${JSON.stringify(env.rateLimitAccountId)},
      "simple": ${JSON.stringify(structural.rateLimitAccountPolicy)}
    }
  ]
}
`;
}

async function ignoredOutputPath(apiRoot, value) {
  if (!value || isAbsolute(value) || !OUTPUT_FILENAME.test(value)) {
    throw new AgentInstallConfigError("Output must be a bare filename matching wrangler.<label>.local.jsonc.");
  }
  const resolved = resolve(apiRoot, value);
  if (!isWithin(resolved, apiRoot)) throw new AgentInstallConfigError("Output must remain under apps/api.");
  requireGitIgnored(apiRoot, resolved, "Output config");
  return resolved;
}

async function existingIgnoredConfig(apiRoot, value) {
  if (!value || isAbsolute(value) || !OUTPUT_FILENAME.test(value)) {
    throw new AgentInstallConfigError("Config must be a bare filename matching wrangler.<label>.local.jsonc.");
  }
  const resolved = resolve(apiRoot, value);
  if (!isWithin(resolved, apiRoot)) throw new AgentInstallConfigError("Config must remain under apps/api.");
  const metadata = await lstat(resolved).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new AgentInstallConfigError("Config must be a regular file, not a symbolic link.");
  }
  if (!(await realpath(resolved)).startsWith(`${await realpath(apiRoot)}${sep}`)) {
    throw new AgentInstallConfigError("Config must not escape apps/api.");
  }
  requireGitIgnored(apiRoot, resolved, "Config");
  return resolved;
}

function readGeneratedEnv(configPath) {
  let parsed;
  try {
    parsed = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  } catch {
    throw new AgentInstallConfigError("Config could not be parsed as valid Wrangler JSONC.");
  }
  const database = (parsed.d1_databases ?? []).find((entry) => entry.binding === "DB");
  const files = (parsed.r2_buckets ?? []).find((entry) => entry.binding === "FILES");
  const sourceLimiter = (parsed.ratelimits ?? []).find((entry) => entry.name === "LOGIN_SOURCE_RATE_LIMITER");
  const accountLimiter = (parsed.ratelimits ?? []).find((entry) => entry.name === "LOGIN_ACCOUNT_RATE_LIMITER");
  if (!parsed.name || !database?.database_name || !files?.bucket_name || !sourceLimiter?.namespace_id || !accountLimiter?.namespace_id) {
    throw new AgentInstallConfigError("Config is missing a field this tool generates; regenerate it with init.");
  }
  // unstable_readConfig normalizes an absent `vars` block to `{}`, not undefined, so an
  // emptiness check (rather than `?? null`) is required to detect "no vars written yet".
  const vars = parsed.vars && Object.keys(parsed.vars).length > 0 ? parsed.vars : null;
  return {
    workerName: parsed.name,
    d1Name: database.database_name,
    d1Id: database.database_id ?? PLACEHOLDER_DATABASE_ID,
    r2Name: files.bucket_name,
    rateLimitSourceId: String(sourceLimiter.namespace_id),
    rateLimitAccountId: String(accountLimiter.namespace_id),
    vars,
  };
}

/** Section 2 [AUTO]: name, D1/R2 identity, and rate-limit IDs only. No vars block yet. */
export async function prepareAgentInstallConfig({ apiRoot, plan, output }) {
  const planValues = await readPlan(apiRoot, plan);
  const structural = readTrackedTemplate(apiRoot);
  const outputPath = await ignoredOutputPath(apiRoot, output);
  const text = renderWranglerConfig(structural, {
    workerName: planValues.workerName,
    d1Name: planValues.d1Name,
    d1Id: PLACEHOLDER_DATABASE_ID,
    r2Name: planValues.r2Name,
    rateLimitSourceId: planValues.rateLimitSourceId,
    rateLimitAccountId: planValues.rateLimitAccountId,
    vars: null,
  });
  try {
    await writeFile(outputPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new AgentInstallConfigError("Deploy config already exists; refusing to overwrite. Remove it yourself to regenerate.");
    }
    throw new AgentInstallConfigError("Deploy config could not be written.");
  }
  return { output: relative(apiRoot, outputPath) };
}

/** Section 3 [GATE] reminder: exact resource-creation commands, printed only, never executed. */
export async function agentInstallResourceCommands({ apiRoot, plan }) {
  const planValues = await readPlan(apiRoot, plan);
  return [
    "[GATE] Present each command separately and wait for the operator's approval before running it.",
    `pnpm --dir apps/api exec wrangler d1 create ${planValues.d1Name}`,
    `pnpm --dir apps/api exec wrangler r2 bucket create ${planValues.r2Name} --storage-class Standard`,
    "After D1 create returns its database_id, run: set-d1-id --config <output> --id <returned-id>",
  ];
}

/** Section 3 [AUTO] patch step: copy the returned D1 database_id into the config. */
export async function setAgentInstallConfigD1Id({ apiRoot, config, id }) {
  if (typeof id !== "string" || !D1_ID.test(id) || id.toLowerCase() === PLACEHOLDER_DATABASE_ID) {
    throw new AgentInstallConfigError("D1 database ID must be the real UUID Wrangler returned, not the tracked placeholder.");
  }
  const configPath = await existingIgnoredConfig(apiRoot, config);
  const structural = readTrackedTemplate(apiRoot);
  const current = readGeneratedEnv(configPath);
  const text = renderWranglerConfig(structural, { ...current, d1Id: id.toLowerCase() });
  await writeFile(configPath, text, "utf8");
  return { output: relative(apiRoot, configPath) };
}

/** Section 4 [AUTO] patch step: add the vars block once the Turnstile widget and hostnames are known. */
export async function setAgentInstallConfigVars({ apiRoot, config, plan, turnstileSiteKey, allowedHostnames }) {
  if (typeof turnstileSiteKey !== "string" || turnstileSiteKey.trim() !== turnstileSiteKey || turnstileSiteKey.length === 0) {
    throw new AgentInstallConfigError("Turnstile site key must be non-empty normalized text.");
  }
  const hostnames = hostnameList(allowedHostnames, "Allowed hostnames").join(",");
  const configPath = await existingIgnoredConfig(apiRoot, config);
  const structural = readTrackedTemplate(apiRoot);
  const current = readGeneratedEnv(configPath);
  const planValues = await readPlan(apiRoot, plan);
  const text = renderWranglerConfig(structural, {
    ...current,
    vars: {
      TURNSTILE_SITE_KEY: turnstileSiteKey,
      TURNSTILE_ALLOWED_HOSTNAMES: hostnames,
      CALENDAR_UID_DOMAIN: planValues.calendarUidDomain,
      SOURCE_URL: planValues.sourceUrl,
    },
  });
  await writeFile(configPath, text, "utf8");
  return { output: relative(apiRoot, configPath) };
}

function parseFlags(argv, required) {
  const options = {};
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!required.includes(flag)) throw new AgentInstallConfigError(`Unknown argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new AgentInstallConfigError(`Missing value for ${flag}.`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  for (const flag of required) {
    if (!(flag.slice(2) in options)) throw new AgentInstallConfigError(`Usage requires ${required.join(" ")}.`);
  }
  return options;
}

export async function runAgentInstallConfigCli({ apiRoot, argv, log = console.log }) {
  const [subcommand, ...rest] = argv[0] === "--" ? argv.slice(1) : argv;
  if (subcommand === "init") {
    const options = parseFlags(rest, ["--plan", "--output"]);
    const result = await prepareAgentInstallConfig({ apiRoot, plan: options.plan, output: options.output });
    log(`Wrote ${result.output} from the install plan (Section 2). D1 database_id is still the placeholder.`);
    log("Next: resource-commands, then create D1/R2 with operator approval, then set-d1-id.");
    return;
  }
  if (subcommand === "resource-commands") {
    const options = parseFlags(rest, ["--plan"]);
    for (const line of await agentInstallResourceCommands({ apiRoot, plan: options.plan })) log(line);
    return;
  }
  if (subcommand === "set-d1-id") {
    const options = parseFlags(rest, ["--config", "--id"]);
    const result = await setAgentInstallConfigD1Id({ apiRoot, config: options.config, id: options.id });
    log(`Updated ${result.output} with the returned D1 database ID (Section 3).`);
    return;
  }
  if (subcommand === "set-vars") {
    const options = parseFlags(rest, ["--config", "--plan", "--turnstile-site-key", "--allowed-hostnames"]);
    const result = await setAgentInstallConfigVars({
      apiRoot,
      config: options.config,
      plan: options.plan,
      turnstileSiteKey: options["turnstile-site-key"],
      allowedHostnames: options["allowed-hostnames"],
    });
    log(`Updated ${result.output} with Turnstile, calendar, and source vars (Section 4).`);
    log("Next: store TURNSTILE_SECRET_KEY yourself with `wrangler secret put` — this tool never touches it.");
    return;
  }
  throw new AgentInstallConfigError("Usage: agent-install-config.mjs <init|resource-commands|set-d1-id|set-vars> ...");
}

async function main() {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runAgentInstallConfigCli({ apiRoot, argv: process.argv.slice(2), log: console.log });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof AgentInstallConfigError ? error.message : "Agent install config command failed.");
    process.exitCode = 1;
  });
}
