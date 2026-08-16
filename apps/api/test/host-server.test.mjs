import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requestAtPublicOrigin, startServer } from "../src/server.ts";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  return address.port;
}

describe("node host public origin", () => {
  let root;
  let localOrigin;
  let running;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "confpilot-host-"));
    const filesDirectory = join(root, "files");
    const staticDirectory = join(root, "web");
    mkdirSync(filesDirectory);
    mkdirSync(staticDirectory);
    writeFileSync(join(staticDirectory, "index.html"), "<!doctype html><title>ConfPilot test</title>");
    const port = await freePort();
    localOrigin = `http://127.0.0.1:${port}`;
    running = await startServer({
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_ORIGIN: "https://confpilot.example.org",
      SOURCE_URL: "https://git.example.org/operator/confpilot",
      DATABASE_PATH: join(root, "confpilot.sqlite"),
      FILES_DIRECTORY: filesDirectory,
      STATIC_DIRECTORY: staticDirectory,
      MIGRATIONS_DIRECTORY: migrationsDirectory,
    });
  }, 30_000);

  afterAll(async () => {
    await running?.shutdown();
    if (root) rmSync(root, { force: true, recursive: true });
  });

  async function login(origin, extraHeaders = {}) {
    return fetch(`${localOrigin}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
        "x-confpilot-request": "1",
        ...extraHeaders,
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong password value" }),
    });
  }

  it("accepts an external HTTPS mutation across a cleartext proxy hop", async () => {
    const response = await login("https://confpilot.example.org");
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("still rejects a mismatched origin even when forwarded headers claim HTTPS", async () => {
    const response = await login("http://confpilot.example.org", {
      "x-forwarded-host": "confpilot.example.org",
      "x-forwarded-proto": "https",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("UNSAFE_REQUEST_REJECTED");
  });

  it("publishes the configured HTTPS origin in the agent manifest", async () => {
    const response = await fetch(`${localOrigin}/api/agent/manifest`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instance.origin).toBe("https://confpilot.example.org");
    expect(body.instance.anonymousIndex).toBe("https://confpilot.example.org/llms.txt");
  });

  it("keeps a double-slash request target on the configured authority", () => {
    const rewritten = requestAtPublicOrigin(
      new Request("http://127.0.0.1:8787//attacker.example/path?value=1"),
      "https://confpilot.example.org",
    );
    expect(rewritten.url).toBe("https://confpilot.example.org//attacker.example/path?value=1");
  });
});
