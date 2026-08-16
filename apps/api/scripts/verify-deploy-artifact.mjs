import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

import { runDeployConfigPreflight } from "./validate-deploy-config.mjs";
import {
  DeploymentVerificationError,
  assertLlmsResponse,
  verifyBuiltSourceOffer,
} from "./verify-deployment.mjs";

function parseArguments(argv) {
  const options = {};
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--config", "--source-url", "--event-slug", "--hostnames"].includes(flag)) {
      throw new DeploymentVerificationError(`Unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new DeploymentVerificationError(`Missing value for ${flag}.`);
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.config || !options["source-url"] || !options["event-slug"] || !options.hostnames) {
    throw new DeploymentVerificationError(
      "Usage: verify-deploy-artifact --config <ignored-config> --source-url <public-source-url> --event-slug <slug> --hostnames <hostname[,hostname]>",
    );
  }
  return {
    config: options.config,
    expectedSourceUrl: options["source-url"],
    defaultEventSlug: options["event-slug"],
    deployedHostnames: options.hostnames.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  if (!port) throw new DeploymentVerificationError("Could not reserve a local verification port.");
  return port;
}

function runWrangler(wranglerPath, args, cwd) {
  try {
    execFileSync(wranglerPath, args, {
      cwd,
      env: {
        ...process.env,
        CLOUDFLARE_API_KEY: "",
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_EMAIL: "",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: "ignore",
    });
  } catch {
    throw new DeploymentVerificationError("Wrangler could not build the exact local deployment artifact.");
  }
}

export async function waitForLlms(origin, child, expectedSourceUrl, {
  fetchImpl = fetch,
  attempts = 80,
  retryDelayMs = 250,
} = {}) {
  const readinessAbort = new AbortController();
  let rejectStartup;
  const startupFailure = new Promise((_, reject) => { rejectStartup = reject; });
  const onStartupError = (error) => {
    readinessAbort.abort();
    rejectStartup(new DeploymentVerificationError("Wrangler could not start the exact local deployment artifact.", {
      cause: error,
    }));
  };
  child.once("error", onStartupError);
  const readiness = (async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (child.exitCode !== null) {
        throw new DeploymentVerificationError("The exact local deployment artifact stopped before verification.");
      }
      try {
        const response = await fetchImpl(`${origin}/llms.txt`, {
          headers: { accept: "text/plain" },
          redirect: "manual",
          signal: AbortSignal.any([readinessAbort.signal, AbortSignal.timeout(1_000)]),
        });
        await assertLlmsResponse(response, { expectedSourceUrl, label: "Local deployment artifact" });
        return;
      } catch (error) {
        if (readinessAbort.signal.aborted) return;
        if (error instanceof DeploymentVerificationError) throw error;
        await new Promise((resolveWait) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolveWait();
          };
          const timer = setTimeout(() => {
            readinessAbort.signal.removeEventListener("abort", onAbort);
            resolveWait();
          }, retryDelayMs);
          readinessAbort.signal.addEventListener("abort", onAbort, { once: true });
        });
        if (readinessAbort.signal.aborted) return;
      }
    }
    throw new DeploymentVerificationError("The exact local deployment artifact did not become ready for verification.");
  })();
  try {
    await Promise.race([readiness, startupFailure]);
  } finally {
    child.removeListener("error", onStartupError);
    readinessAbort.abort();
  }
}

export async function verifyDeployArtifact({
  apiRoot,
  config,
  expectedSourceUrl,
  defaultEventSlug,
  deployedHostnames,
}) {
  const verified = await runDeployConfigPreflight({
    apiRoot,
    config,
    expectedSourceUrl,
    defaultEventSlug,
    deployedHostnames,
  });
  await verifyBuiltSourceOffer({ webDist: resolve(apiRoot, "../web/dist"), expectedSourceUrl: verified.sourceUrl });

  const configPath = resolve(apiRoot, config);
  const parsed = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  const databaseName = parsed.d1_databases?.find((entry) => entry.binding === "DB")?.database_name;
  if (!databaseName) throw new DeploymentVerificationError("The verified deploy config does not name its DB resource.");

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "confpilot-deploy-artifact-"));
  const stateDirectory = resolve(temporaryRoot, "state");
  const artifactDirectory = resolve(temporaryRoot, "worker");
  const wranglerPath = resolve(apiRoot, "node_modules/.bin/wrangler");
  let child;
  try {
    runWrangler(wranglerPath, [
      "d1", "migrations", "apply", databaseName,
      "--local", "--persist-to", stateDirectory, "--config", configPath,
    ], apiRoot);
    runWrangler(wranglerPath, [
      "deploy", "--dry-run", "--outdir", artifactDirectory, "--config", configPath,
    ], apiRoot);

    const port = await availablePort();
    child = spawn(wranglerPath, [
      "dev", resolve(artifactDirectory, "index.js"), "--no-bundle",
      "--local", "--persist-to", stateDirectory, "--config", configPath,
      "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--log-level", "error",
    ], {
      cwd: apiRoot,
      env: {
        ...process.env,
        CLOUDFLARE_API_KEY: "",
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_EMAIL: "",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: "ignore",
    });
    await waitForLlms(`http://127.0.0.1:${port}`, child, verified.sourceUrl);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => {
        child.once("exit", resolveExit);
        setTimeout(resolveExit, 2_000);
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return verified;
}

export async function runDeployArtifactCli({ apiRoot, argv, log = console.log }) {
  await verifyDeployArtifact({ apiRoot, ...parseArguments(argv) });
  log("Exact deploy-shaped Worker artifact is ready.");
  log("Verified the built source offer and confirmed /llms.txt is Worker-generated text/plain rather than the SPA shell.");
  log("Wrangler ran only with --dry-run or --local; no remote resource or deployment was read or changed.");
}

async function main() {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runDeployArtifactCli({ apiRoot, argv: process.argv.slice(2) });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
