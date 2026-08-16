/**
 * The Node host's asset handling, which is where Cloudflare's platform behaviour
 * has to be reproduced rather than inherited.
 *
 * Two of these are security properties rather than conveniences: the response
 * headers must follow the requested path rather than the file that answers it,
 * and a request path must never reach outside the build directory. Both are
 * invisible on Cloudflare — the platform does them — so both are only ever true
 * here because something checks.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStaticAssetHandler, isApplicationPath, resolveWithin } from "../src/host/static-assets.ts";
import { headersForPath } from "../src/runtime/security-headers.ts";

describe("node host static assets", () => {
  let directory;
  let serve;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "confpilot-static-"));
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<!doctype html><title>ConfPilot</title>");
    writeFileSync(join(directory, "assets", "index-abc123.js"), "console.log('app')");
    serve = createStaticAssetHandler(directory);
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  const get = (path, method = "GET") => serve(new Request(`https://confpilot.test${path}`, { method }));

  it("leaves application paths to the application", async () => {
    // Mirrors run_worker_first: these three reach the Worker on Cloudflare, so
    // the handler must decline them rather than answer with the SPA shell.
    for (const path of ["/api", "/api/events", "/llms.txt"]) {
      expect(await get(path), path).toBeNull();
    }
    expect(isApplicationPath("/apifoo"), "a prefix is not a path segment").toBe(false);
  });

  it("declines methods the platform would not serve from assets", async () => {
    expect(await get("/", "POST")).toBeNull();
  });

  it("serves a built file with its own content type", async () => {
    const response = await get("/assets/index-abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("console.log('app')");
  });

  it("serves an unknown extension as an octet stream rather than guessing", async () => {
    writeFileSync(join(directory, "payload.weird"), "x");
    const response = await get("/payload.weird");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("falls back to the shell for a route the SPA owns", async () => {
    const response = await get("/events/devflow-2026/agenda");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ConfPilot");
  });

  it("falls back for a missing asset too, as the platform does", async () => {
    // Cloudflare's single-page-application handling answers every miss with the
    // shell. A friendlier 404 here would make the two hosts disagree.
    const response = await get("/assets/deleted.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  describe("headers follow the requested path, not the file that answers it", () => {
    it("denies framing on an authenticated route served by the fallback", async () => {
      // /admin is answered with index.html. Resolving headers from the file would
      // give it the shell's policy and silently un-protect every such route.
      const response = await get("/admin");
      const expected = headersForPath("/admin");
      expect(expected.get("x-frame-options"), "fixture assumption: /admin is frame-denied").toBe("DENY");
      for (const [name, value] of expected) {
        expect(response.headers.get(name), `${name} on /admin`).toBe(value);
      }
    });

    it("leaves embed routes framable, though they are served the same bytes", async () => {
      const response = await get("/embed/devflow-2026");
      expect(response.headers.get("x-frame-options")).toBeNull();
      expect(await response.text()).toContain("ConfPilot");
    });

    it("gives a real file the policy for its own path", async () => {
      const response = await get("/assets/index-abc123.js");
      for (const [name, value] of headersForPath("/assets/index-abc123.js")) {
        expect(response.headers.get(name), name).toBe(value);
      }
    });
  });

  describe("containment", () => {
    it.each([
      ["a parent traversal", "/../secret.txt"],
      ["a nested traversal", "/assets/../../secret.txt"],
      ["an encoded traversal", "/%2e%2e/secret.txt"],
      ["a doubly encoded traversal", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt"],
    ])("refuses %s", (_label, path) => {
      expect(resolveWithin(directory, path)).toBeNull();
    });

    it("refuses a null byte and a malformed escape", () => {
      expect(resolveWithin(directory, "/index.html\0.js")).toBeNull();
      expect(resolveWithin(directory, "/%zz")).toBeNull();
    });

    it("permits paths that stay inside", () => {
      expect(resolveWithin(directory, "/assets/index-abc123.js")).toBe(join(directory, "assets", "index-abc123.js"));
      expect(resolveWithin(directory, "/")).toBe(directory);
    });

    it("does not follow a symlink out of the build directory", async () => {
      // Lexical containment passes here — the request path never leaves the root.
      // The escape is on disk, and only resolving the real path catches it.
      // Adversarial review served an outside file through exactly this, as
      // text/javascript on the app's own origin.
      const outside = join(directory, "..", `linked-secret-${process.pid}.txt`);
      writeFileSync(outside, "SECRET-OUTSIDE-ROOT");
      symlinkSync(outside, join(directory, "assets", "linked.js"));
      try {
        const response = await get("/assets/linked.js");
        expect(await response.text()).not.toContain("SECRET-OUTSIDE-ROOT");
        expect(response.headers.get("content-type"), "must not be served as script")
          .not.toBe("text/javascript; charset=utf-8");
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it("still serves a symlink that stays inside the build directory", async () => {
      // The check is containment, not a ban on links: a build that symlinks
      // within its own output is still a build we serve.
      writeFileSync(join(directory, "real.js"), "console.log('inside')");
      symlinkSync(join(directory, "real.js"), join(directory, "assets", "aliased.js"));
      const response = await get("/assets/aliased.js");
      expect(await response.text()).toBe("console.log('inside')");
    });

    it("does not serve a file outside the build directory", async () => {
      // The escape attempt reaches the handler, not just the resolver, so the
      // containment check is proven to be wired in rather than merely present.
      const outside = join(directory, "..", `escaped-${process.pid}.txt`);
      writeFileSync(outside, "secret");
      try {
        const response = await get(`/../escaped-${process.pid}.txt`);
        expect(await response.text()).not.toContain("secret");
      } finally {
        rmSync(outside, { force: true });
      }
    });
  });

  it("reports a missing build rather than answering with nothing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "confpilot-empty-"));
    try {
      const response = await createStaticAssetHandler(empty)(new Request("https://confpilot.test/admin"));
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("build");
    } finally {
      rmSync(empty, { force: true, recursive: true });
    }
  });
});
