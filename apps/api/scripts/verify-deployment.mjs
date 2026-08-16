import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_ARTIFACT_EXTENSIONS = new Set([".css", ".html", ".js"]);
const SPA_SHELL_MARKERS = /<!doctype\s+html|<html(?:\s|>)|<script(?:\s|>)|<div[^>]+id=["']root["']/i;

export class DeploymentVerificationError extends Error {}

function normalizedPublicUrl(value, label, { originOnly = false } = {}) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0) {
    throw new DeploymentVerificationError(`${label} must be an absolute HTTPS URL.`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || (originOnly && (url.pathname !== "/" || url.search))) {
      throw new Error();
    }
    return originOnly ? url.origin : url.toString();
  } catch {
    throw new DeploymentVerificationError(`${label} must be an absolute HTTPS URL without credentials.`);
  }
}

export async function assertLlmsResponse(response, { expectedSourceUrl, label = "Deployment" }) {
  if (response.status !== 200) {
    throw new DeploymentVerificationError(`${label} /llms.txt returned ${response.status}, expected 200.`);
  }

  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "text/plain") {
    throw new DeploymentVerificationError(`${label} /llms.txt must be served as text/plain, not the SPA shell.`);
  }

  const body = await response.text();
  if (!body.startsWith("# ConfPilot") || SPA_SHELL_MARKERS.test(body)) {
    throw new DeploymentVerificationError(`${label} /llms.txt is not the Worker-generated ConfPilot document.`);
  }
  if (!body.includes(expectedSourceUrl)) {
    throw new DeploymentVerificationError(`${label} /llms.txt does not expose the expected Corresponding Source URL.`);
  }
}

export async function verifyLiveDeployment({ origins, expectedSourceUrl, fetchImpl = fetch }) {
  const sourceUrl = normalizedPublicUrl(expectedSourceUrl, "Expected source URL");
  if (!Array.isArray(origins) || origins.length < 2) {
    throw new DeploymentVerificationError("At least the apex and www deployment origins must be verified.");
  }
  const normalizedOrigins = origins.map((origin, index) =>
    normalizedPublicUrl(origin, `Deployment origin ${index + 1}`, { originOnly: true }));
  if (new Set(normalizedOrigins).size !== normalizedOrigins.length) {
    throw new DeploymentVerificationError("Deployment origins must be unique.");
  }

  for (const [index, origin] of normalizedOrigins.entries()) {
    let response;
    try {
      response = await fetchImpl(`${origin}/llms.txt`, {
        headers: { accept: "text/plain" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new DeploymentVerificationError(`Deployment origin ${index + 1} /llms.txt could not be read.`);
    }
    await assertLlmsResponse(response, {
      expectedSourceUrl: sourceUrl,
      label: `Deployment origin ${index + 1}`,
    });
  }

  return { origins: normalizedOrigins.length, sourceUrl };
}

async function textArtifactFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await textArtifactFiles(path));
    else if (entry.isFile() && TEXT_ARTIFACT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export async function verifyBuiltSourceOffer({ webDist, expectedSourceUrl }) {
  const sourceUrl = normalizedPublicUrl(expectedSourceUrl, "Expected source URL");
  let files;
  try {
    files = await textArtifactFiles(webDist);
  } catch {
    throw new DeploymentVerificationError("The production web artifact is missing or unreadable; build it before verification.");
  }
  if (files.length === 0) {
    throw new DeploymentVerificationError("The production web artifact contains no inspectable HTML, JavaScript, or CSS files.");
  }
  for (const path of files) {
    if ((await readFile(path, "utf8")).includes(sourceUrl)) return { sourceUrl };
  }
  throw new DeploymentVerificationError(
    "The production web artifact does not contain the expected Corresponding Source URL; rebuild it with the verified VITE_SOURCE_URL.",
  );
}

function parseLiveArguments(argv) {
  const options = {};
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--source-url", "--origins"].includes(flag)) {
      throw new DeploymentVerificationError(`Unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new DeploymentVerificationError(`Missing value for ${flag}.`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options["source-url"] || !options.origins) {
    throw new DeploymentVerificationError(
      "Usage: verify-deployment --source-url <public-source-url> --origins <apex-origin,www-origin>",
    );
  }
  return {
    expectedSourceUrl: options["source-url"],
    origins: options.origins.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

export async function runLiveVerificationCli({ argv, log = console.log, fetchImpl = fetch }) {
  const result = await verifyLiveDeployment({ ...parseLiveArguments(argv), fetchImpl });
  log(`Verified Worker-generated /llms.txt content on ${result.origins} deployment origins.`);
  log("Every response was 200 text/plain, was not the SPA shell, and exposed the expected Corresponding Source URL.");
}

async function main() {
  await runLiveVerificationCli({ argv: process.argv.slice(2) });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
