import { execFileSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_RATE_LIMIT_IDS = new Set(["1001", "1002"]);
// Keep aligned with Cloudflare's published test sitekeys:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/#test-sitekeys
const NON_PRODUCTION_TURNSTILE_SITE_KEYS = new Set([
  "replace-with-public-site-key",
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const WORKER_FIRST_PATHS = ["/api", "/api/*", "/llms.txt"];

export class DeployConfigError extends Error {}

function normalizedHttpUrl(value, label) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0) {
    throw new DeployConfigError(`${label} must be an absolute HTTP(S) URL.`);
  }
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new DeployConfigError(`${label} must be an absolute HTTP(S) URL without embedded credentials.`);
  }
}

function normalizedHostname(value, label) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0
    || value.includes(":") || value.includes("/") || value.includes("*")) {
    throw new DeployConfigError(`${label} must be one exact hostname without a scheme, port, path, or wildcard.`);
  }
  try {
    const hostname = new URL(`https://${value}`).hostname;
    if (hostname !== value.toLowerCase()) throw new Error();
    return hostname;
  } catch {
    throw new DeployConfigError(`${label} must be one normalized hostname.`);
  }
}

function oneBinding(collection, binding, label, identityField = "binding") {
  const matches = (collection ?? []).filter((entry) => entry[identityField] === binding);
  if (matches.length !== 1) throw new DeployConfigError(`The deploy config must define exactly one ${label} binding named ${binding}.`);
  return matches[0];
}

function hostnameList(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new DeployConfigError(`${label} must include at least one deployed hostname.`);
  }
  const hostnames = values.map((value) => normalizedHostname(value, `${label} entry`));
  if (new Set(hostnames).size !== hostnames.length) {
    throw new DeployConfigError(`${label} entries must be unique.`);
  }
  return hostnames;
}

function requireRatePolicy(binding, expectedLimit, expectedPeriod) {
  if (binding.simple?.limit !== expectedLimit || binding.simple?.period !== expectedPeriod) {
    throw new DeployConfigError(
      `${binding.name} must use the reviewed ${expectedLimit}-request/${expectedPeriod}-second policy.`,
    );
  }
}

function configPathMatches(value, apiRoot, relativePath) {
  if (value === relativePath) return true;
  return typeof value === "string" && typeof apiRoot === "string"
    && resolve(value) === resolve(apiRoot, relativePath);
}

/**
 * Validate local deployment structure without returning configured resource
 * identities. Secret presence is verified separately by name through Wrangler
 * immediately before a remote deployment.
 */
export function validateDeploymentConfig(config, {
  expectedSourceUrl,
  defaultEventSlug,
  deployedHostnames,
  apiRoot,
}) {
  const workerFirst = config.assets?.run_worker_first ?? [];
  for (const path of WORKER_FIRST_PATHS) {
    if (!workerFirst.includes(path)) {
      throw new DeployConfigError(`The deploy config must route ${path} through the Worker before the SPA fallback.`);
    }
  }
  if (!configPathMatches(config.main, apiRoot, "src/index.ts")
    || !configPathMatches(config.assets?.directory, apiRoot, "../web/dist")
    || config.assets?.binding !== "ASSETS"
    || config.assets?.not_found_handling !== "single-page-application") {
    throw new DeployConfigError("The deploy config must use the ConfPilot Worker entrypoint, production web build, same-origin ASSETS binding, and SPA fallback.");
  }

  const configuredSource = normalizedHttpUrl(config.vars?.SOURCE_URL, "SOURCE_URL");
  const expectedSource = normalizedHttpUrl(expectedSourceUrl, "Expected source URL");
  if (configuredSource !== expectedSource) {
    throw new DeployConfigError("SOURCE_URL must exactly match the source URL used for the frontend build.");
  }

  if (typeof defaultEventSlug !== "string" || defaultEventSlug !== defaultEventSlug.trim()
    || !EVENT_SLUG.test(defaultEventSlug)) {
    throw new DeployConfigError("The default event slug must be a normalized lowercase slug.");
  }

  const calendarDomain = normalizedHostname(config.vars?.CALENDAR_UID_DOMAIN, "CALENDAR_UID_DOMAIN");
  const expectedHostnames = hostnameList(deployedHostnames, "Deployed hostnames");
  const allowedHostnames = String(config.vars?.TURNSTILE_ALLOWED_HOSTNAMES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizedHostname(value, "TURNSTILE_ALLOWED_HOSTNAMES entry"));
  const turnstileSiteKey = config.vars?.TURNSTILE_SITE_KEY;
  if (typeof turnstileSiteKey !== "string" || !turnstileSiteKey.trim()
    || NON_PRODUCTION_TURNSTILE_SITE_KEYS.has(turnstileSiteKey.trim())
    || allowedHostnames.length === 0) {
    throw new DeployConfigError("The deploy config must include a production Turnstile site key and exact allowed hostnames.");
  }
  if (allowedHostnames.length !== expectedHostnames.length
    || expectedHostnames.some((hostname) => !allowedHostnames.includes(hostname))) {
    throw new DeployConfigError("TURNSTILE_ALLOWED_HOSTNAMES must exactly match the deployed hostnames.");
  }

  const database = oneBinding(config.d1_databases, "DB", "D1");
  if (!database.database_id || database.database_id === PLACEHOLDER_DATABASE_ID) {
    throw new DeployConfigError("The DB binding must use a non-placeholder database ID.");
  }
  const files = oneBinding(config.r2_buckets, "FILES", "private R2");
  if (!files.bucket_name) throw new DeployConfigError("The FILES binding must name a private R2 bucket.");

  const sourceLimiter = oneBinding(config.ratelimits, "LOGIN_SOURCE_RATE_LIMITER", "rate limit", "name");
  const accountLimiter = oneBinding(config.ratelimits, "LOGIN_ACCOUNT_RATE_LIMITER", "rate limit", "name");
  requireRatePolicy(sourceLimiter, 20, 60);
  requireRatePolicy(accountLimiter, 5, 60);
  const rateIds = [String(sourceLimiter.namespace_id ?? ""), String(accountLimiter.namespace_id ?? "")];
  if (rateIds.some((value) => !/^[1-9][0-9]*$/.test(value) || PLACEHOLDER_RATE_LIMIT_IDS.has(value))
    || rateIds[0] === rateIds[1]) {
    throw new DeployConfigError("Login rate-limit namespace IDs must be positive, distinct, and replace the tracked placeholders.");
  }

  return {
    defaultEventSlug,
    sourceUrl: configuredSource,
    calendarDomain,
    deployedHostnames: expectedHostnames,
  };
}

function parseArguments(argv) {
  const options = {};
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--config", "--source-url", "--event-slug", "--hostnames"].includes(flag)) {
      throw new DeployConfigError(`Unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new DeployConfigError(`Missing value for ${flag}.`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.config || !options["source-url"] || !options["event-slug"] || !options.hostnames) {
    throw new DeployConfigError("Usage: validate-deploy-config --config <ignored-config> --source-url <public-source-url> --event-slug <slug> --hostnames <hostname[,hostname]>");
  }
  return {
    config: options.config,
    expectedSourceUrl: options["source-url"],
    defaultEventSlug: options["event-slug"],
    deployedHostnames: options.hostnames.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

async function localIgnoredConfig(apiRoot, value) {
  if (isAbsolute(value)) throw new DeployConfigError("Deploy config must be a relative path under apps/api.");
  const path = resolve(apiRoot, value);
  if (!(path === apiRoot || path.startsWith(`${apiRoot}${sep}`))) {
    throw new DeployConfigError("Deploy config must remain under apps/api.");
  }
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new DeployConfigError("Deploy config must be a regular file, not a symbolic link.");
  }
  if (!(await realpath(path)).startsWith(`${await realpath(apiRoot)}${sep}`)) {
    throw new DeployConfigError("Deploy config must not escape apps/api.");
  }
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", relative(apiRoot, path)], {
      cwd: apiRoot,
      stdio: "ignore",
    });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      throw new DeployConfigError("Deploy config must be ignored by Git before provider identifiers are added.");
    }
    throw new DeployConfigError(
      "Git must be available and apps/api must be inside a Git worktree before deploy config can be verified.",
    );
  }
  return path;
}

export async function runDeployConfigPreflight({
  apiRoot,
  config,
  expectedSourceUrl,
  defaultEventSlug,
  deployedHostnames,
}) {
  const configPath = await localIgnoredConfig(apiRoot, config);
  let parsed;
  try {
    parsed = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  } catch {
    throw new DeployConfigError("Deploy config could not be parsed as valid Wrangler JSONC.");
  }
  if ((parsed.definedEnvironments ?? []).length > 0) {
    throw new DeployConfigError(
      "Deploy config must not define named environments; use one ignored config file per deployment environment.",
    );
  }
  return validateDeploymentConfig(parsed, {
    expectedSourceUrl,
    defaultEventSlug,
    deployedHostnames,
    apiRoot,
  });
}

export async function runDeployConfigCli({ apiRoot, argv, log = console.log }) {
  await runDeployConfigPreflight({ apiRoot, ...parseArguments(argv) });
  log("Deploy config structure is ready.");
  log("Verified same-origin routing, source offer, event slug, calendar identity, deployed Turnstile host scope, and non-placeholder D1/R2/rate-limit bindings.");
  log("No secret or provider identifier was printed or transmitted, and no remote resource or deployment was read or changed.");
}

async function main() {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runDeployConfigCli({ apiRoot, argv: process.argv.slice(2) });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
