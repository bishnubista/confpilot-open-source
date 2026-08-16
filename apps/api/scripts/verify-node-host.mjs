import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";

import { migrationNames } from "./migration-files.mjs";
import { assertLlmsResponse, verifyBuiltSourceOffer } from "./verify-deployment.mjs";

const apiRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(apiRoot, "../..");
const serverPath = resolve(apiRoot, "dist-node/server.mjs");
const migrationsDirectory = resolve(apiRoot, "migrations");
const staticDirectory = resolve(repositoryRoot, "apps/web/dist");

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!address || typeof address === "string") throw new Error("Could not allocate a Node-host smoke port.");
  return address.port;
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    let timeout;
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      if (signal === "SIGTERM" || code === 0) resolveExit();
      else reject(new Error(`Node host exited with ${code ?? signal}.`));
    };
    child.once("exit", onExit);
    // Close the small gap between the check above and listener registration.
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      onExit(child.exitCode, child.signalCode);
      return;
    }
    timeout = setTimeout(() => {
      child.off("exit", onExit);
      child.kill("SIGKILL");
      reject(new Error("Node host did not exit within 10 seconds of SIGTERM."));
    }, 10_000);
    child.kill("SIGTERM");
  });
}

async function waitForServer(origin, child, sourceUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Node host stopped before becoming ready.");
    let response;
    try {
      response = await fetch(`${origin}/llms.txt`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      // Startup applies the complete schema; retry until the bounded deadline.
    }
    if (response?.ok) {
      await assertLlmsResponse(response, { expectedSourceUrl: sourceUrl, label: "Node host" });
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Node host did not become ready within 8 seconds.");
}

function launch({ port, databasePath, filesDirectory, sourceUrl, publicOrigin }) {
  const stderr = [];
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_ORIGIN: publicOrigin,
      SOURCE_URL: sourceUrl,
      DATABASE_PATH: databasePath,
      FILES_DIRECTORY: filesDirectory,
      STATIC_DIRECTORY: staticDirectory,
      MIGRATIONS_DIRECTORY: migrationsDirectory,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.once("exit", () => {
    if (child.exitCode !== 0 && stderr.length > 0) process.stderr.write(stderr.join(""));
  });
  return child;
}

async function expectStatus(response, status, label) {
  if (response.status !== status) throw new Error(`${label} returned ${response.status}, expected ${status}.`);
  return response;
}

async function main() {
  const sourceUrl = process.env.SOURCE_URL;
  if (!sourceUrl) throw new Error("SOURCE_URL must be set for the Node-host smoke.");
  await verifyBuiltSourceOffer({ webDist: staticDirectory, expectedSourceUrl: sourceUrl });

  const root = await mkdtemp(resolve(tmpdir(), "confpilot-node-smoke-"));
  const filesDirectory = resolve(root, "files");
  const databasePath = resolve(root, "confpilot.sqlite");
  await mkdir(filesDirectory);
  const port = await freePort();
  const localOrigin = `http://127.0.0.1:${port}`;
  const publicOrigin = "https://node-smoke.example.test";
  let child;
  try {
    child = launch({ port, databasePath, filesDirectory, sourceUrl, publicOrigin });
    await waitForServer(localOrigin, child, sourceUrl);

    const admin = await expectStatus(await fetch(`${localOrigin}/admin`), 200, "SPA fallback");
    if (admin.headers.get("x-frame-options") !== "DENY") throw new Error("Authenticated SPA route is framable.");
    const embed = await expectStatus(await fetch(`${localOrigin}/embed/smoke/example`), 200, "Public embed fallback");
    if (embed.headers.has("x-frame-options")) throw new Error("Public embed route is unexpectedly frame-denied.");

    const safeMutation = await fetch(`${localOrigin}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: publicOrigin,
        "sec-fetch-site": "same-origin",
        "x-confpilot-request": "1",
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong password value" }),
    });
    await expectStatus(safeMutation, 401, "Configured-origin login body");
    if ((await safeMutation.json()).error?.code !== "INVALID_CREDENTIALS") {
      throw new Error("Configured-origin login body did not reach the credential handler.");
    }
    const unsafeMutation = await fetch(`${localOrigin}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: localOrigin,
        "sec-fetch-site": "same-origin",
        "x-confpilot-request": "1",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong password value" }),
    });
    await expectStatus(unsafeMutation, 403, "Mismatched-origin mutation");

    await stop(child);
    child = undefined;
    const database = new BetterSqlite3(databasePath, { readonly: true });
    const applied = database.prepare("SELECT COUNT(*) AS count FROM d1_migrations").get().count;
    database.close();
    const expected = migrationNames(await readdir(migrationsDirectory)).length;
    if (applied !== expected) throw new Error(`${applied} migrations were recorded, expected ${expected}.`);

    child = launch({ port, databasePath, filesDirectory, sourceUrl, publicOrigin });
    await waitForServer(localOrigin, child, sourceUrl);
    console.log(`Node host smoke passed with ${applied} migrations and restart persistence.`);
  } finally {
    if (child) await stop(child).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
