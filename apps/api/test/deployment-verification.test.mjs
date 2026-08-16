import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeploymentVerificationError,
  assertLlmsResponse,
  runLiveVerificationCli,
  verifyBuiltSourceOffer,
  verifyLiveDeployment,
} from "../scripts/verify-deployment.mjs";
import { waitForLlms } from "../scripts/verify-deploy-artifact.mjs";

const SOURCE_URL = "https://git.example.org/community/confpilot";
const temporaryRoots = [];

function llmsResponse({
  body = `# ConfPilot\n\n## About this software\n\n- [ConfPilot source code](${SOURCE_URL})`,
  contentType = "text/plain; charset=utf-8",
  status = 200,
} = {}) {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("deployment verification", () => {
  it("accepts Worker-generated llms.txt with the expected source offer", async () => {
    await expect(assertLlmsResponse(llmsResponse(), { expectedSourceUrl: SOURCE_URL })).resolves.toBeUndefined();
  });

  it("rejects a 200 SPA shell instead of treating status as sufficient", async () => {
    const shell = llmsResponse({
      body: `<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>`,
      contentType: "text/html; charset=utf-8",
    });
    await expect(assertLlmsResponse(shell, { expectedSourceUrl: SOURCE_URL }))
      .rejects.toThrow("text/plain, not the SPA shell");

    const mislabeledShell = llmsResponse({
      body: `# ConfPilot\n<html><body>${SOURCE_URL}</body></html>`,
    });
    await expect(assertLlmsResponse(mislabeledShell, { expectedSourceUrl: SOURCE_URL }))
      .rejects.toThrow("not the Worker-generated");

    await expect(assertLlmsResponse(llmsResponse({ contentType: "text/plainx" }), {
      expectedSourceUrl: SOURCE_URL,
    })).rejects.toThrow("must be served as text/plain");
  });

  it("turns a Wrangler startup error into an intentional verification failure", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    const startupError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const verification = waitForLlms("http://127.0.0.1:8787", child, SOURCE_URL, {
      fetchImpl,
      retryDelayMs: 0,
    });

    child.emit("error", startupError);

    await expect(verification).rejects.toMatchObject({
      message: "Wrangler could not start the exact local deployment artifact.",
      cause: startupError,
    });
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("rejects a missing or wrong source offer", async () => {
    await expect(assertLlmsResponse(llmsResponse({ body: "# ConfPilot\n\nNo source offer" }), {
      expectedSourceUrl: SOURCE_URL,
    })).rejects.toThrow("Corresponding Source URL");
    await expect(assertLlmsResponse(llmsResponse({ status: 503 }), {
      expectedSourceUrl: SOURCE_URL,
    })).rejects.toThrow("returned 503");
  });

  it("checks apex and www independently without following redirects", async () => {
    const fetchImpl = vi.fn(async () => llmsResponse());
    await expect(verifyLiveDeployment({
      origins: ["https://cfp.example.org", "https://www.cfp.example.org"],
      expectedSourceUrl: SOURCE_URL,
      fetchImpl,
    })).resolves.toEqual({ origins: 2, sourceUrl: SOURCE_URL });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://cfp.example.org/llms.txt", expect.objectContaining({
      redirect: "manual",
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://www.cfp.example.org/llms.txt", expect.objectContaining({
      redirect: "manual",
    }));
  });

  it("requires two unique HTTPS origins", async () => {
    await expect(verifyLiveDeployment({
      origins: ["https://cfp.example.org"], expectedSourceUrl: SOURCE_URL,
    })).rejects.toThrow("apex and www");
    await expect(verifyLiveDeployment({
      origins: ["http://cfp.example.org", "https://www.cfp.example.org"], expectedSourceUrl: SOURCE_URL,
    })).rejects.toThrow("absolute HTTPS URL");
    await expect(verifyLiveDeployment({
      origins: ["https://cfp.example.org", "https://cfp.example.org"], expectedSourceUrl: SOURCE_URL,
    })).rejects.toThrow("must be unique");
  });

  it("binds artifact verification to the source URL embedded by the production build", async () => {
    const root = mkdtempSync(join(tmpdir(), "confpilot-web-artifact-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<div id=\"root\"></div>");
    writeFileSync(join(root, "assets", "app.js"), `const source=${JSON.stringify(SOURCE_URL)};`);

    await expect(verifyBuiltSourceOffer({ webDist: root, expectedSourceUrl: SOURCE_URL }))
      .resolves.toEqual({ sourceUrl: SOURCE_URL });
    await expect(verifyBuiltSourceOffer({
      webDist: root,
      expectedSourceUrl: "https://git.example.org/community/different",
    })).rejects.toThrow("does not contain the expected");
  });

  it("keeps the live CLI output generic", async () => {
    const messages = [];
    await runLiveVerificationCli({
      argv: ["--source-url", SOURCE_URL, "--origins", "https://cfp.example.org,https://www.cfp.example.org"],
      fetchImpl: async () => llmsResponse(),
      log: (message) => messages.push(message),
    });

    expect(messages.join("\n")).toContain("2 deployment origins");
    expect(messages.join("\n")).not.toContain("cfp.example.org");
  });

  it("uses intentional errors for invalid input", async () => {
    await expect(verifyLiveDeployment({
      origins: ["https://user:secret@cfp.example.org", "https://www.cfp.example.org"],
      expectedSourceUrl: SOURCE_URL,
    })).rejects.toBeInstanceOf(DeploymentVerificationError);
  });
});
