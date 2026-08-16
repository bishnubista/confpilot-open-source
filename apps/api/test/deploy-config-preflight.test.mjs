import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeployConfigError,
  runDeployConfigCli,
  runDeployConfigPreflight,
  validateDeploymentConfig,
} from "../scripts/validate-deploy-config.mjs";

const temporaryRoots = [];

function validConfig() {
  return {
    name: "community-conf",
    main: "src/index.ts",
    assets: {
      directory: "../web/dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/llms.txt"],
    },
    vars: {
      SOURCE_URL: "https://git.example.org/community/confpilot",
      CALENDAR_UID_DOMAIN: "cfp.example.org",
      TURNSTILE_SITE_KEY: "public-site-key",
      TURNSTILE_ALLOWED_HOSTNAMES: "cfp.example.org,community-conf.example.workers.dev",
    },
    d1_databases: [{ binding: "DB", database_id: "11111111-2222-3333-4444-555555555555" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "community-conf-files" }],
    ratelimits: [
      { name: "LOGIN_SOURCE_RATE_LIMITER", namespace_id: "2001", simple: { limit: 20, period: 60 } },
      { name: "LOGIN_ACCOUNT_RATE_LIMITER", namespace_id: "2002", simple: { limit: 5, period: 60 } },
    ],
  };
}

const input = {
  expectedSourceUrl: "https://git.example.org/community/confpilot",
  defaultEventSlug: "community-conf",
  deployedHostnames: ["cfp.example.org", "community-conf.example.workers.dev"],
};

function configFixture({
  config = validConfig(),
  filename = "wrangler.test.local.jsonc",
  ignored = true,
  repository = true,
  contents,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "confpilot-deploy-preflight-"));
  temporaryRoots.push(root);
  if (repository) execFileSync("git", ["init", "--quiet"], { cwd: root });
  if (ignored) writeFileSync(join(root, ".gitignore"), "wrangler.*.local.jsonc\n");
  writeFileSync(join(root, filename), contents ?? JSON.stringify(config));
  return { root, filename };
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("deployment config preflight", () => {
  it("accepts a production-shaped same-origin config without exposing identifiers", () => {
    const result = validateDeploymentConfig(validConfig(), input);

    expect(result).toEqual({
      defaultEventSlug: "community-conf",
      sourceUrl: "https://git.example.org/community/confpilot",
      calendarDomain: "cfp.example.org",
      deployedHostnames: ["cfp.example.org", "community-conf.example.workers.dev"],
    });
  });

  it("requires llms.txt to reach the Worker before the SPA fallback", () => {
    const config = validConfig();
    config.assets.run_worker_first = ["/api", "/api/*"];

    expect(() => validateDeploymentConfig(config, input))
      .toThrow("route /llms.txt through the Worker");
  });

  it("requires the API source offer to match the frontend build source exactly", () => {
    const mismatch = validConfig();
    mismatch.vars.SOURCE_URL = "https://git.example.org/community/different";
    expect(() => validateDeploymentConfig(mismatch, input)).toThrow("exactly match");

    const credentials = validConfig();
    credentials.vars.SOURCE_URL = "https://user:secret@git.example.org/community/confpilot";
    expect(() => validateDeploymentConfig(credentials, input)).toThrow("without embedded credentials");
  });

  it("validates calendar identity independently from every deployed Turnstile hostname", () => {
    const missingCalendar = validConfig();
    delete missingCalendar.vars.CALENDAR_UID_DOMAIN;
    expect(() => validateDeploymentConfig(missingCalendar, input)).toThrow("CALENDAR_UID_DOMAIN");

    const mismatchedTurnstile = validConfig();
    mismatchedTurnstile.vars.CALENDAR_UID_DOMAIN = "calendar-identity.example.org";
    expect(() => validateDeploymentConfig(mismatchedTurnstile, input)).not.toThrow();

    mismatchedTurnstile.vars.TURNSTILE_ALLOWED_HOSTNAMES = "cfp.example.org";
    expect(() => validateDeploymentConfig(mismatchedTurnstile, input)).toThrow("exactly match the deployed hostnames");

    const extraTurnstileHostname = validConfig();
    extraTurnstileHostname.vars.TURNSTILE_ALLOWED_HOSTNAMES += ",unrelated.example.org";
    expect(() => validateDeploymentConfig(extraTurnstileHostname, input))
      .toThrow("exactly match the deployed hostnames");

    const placeholder = validConfig();
    placeholder.vars.TURNSTILE_SITE_KEY = "replace-with-public-site-key";
    expect(() => validateDeploymentConfig(placeholder, input)).toThrow("production Turnstile site key");
  });

  it.each([
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "1x00000000000000000000BB",
    "2x00000000000000000000BB",
    "3x00000000000000000000FF",
  ])("rejects Cloudflare's published Turnstile test sitekey %s", (siteKey) => {
    const config = validConfig();
    config.vars.TURNSTILE_SITE_KEY = siteKey;

    expect(() => validateDeploymentConfig(config, input)).toThrow("production Turnstile site key");
  });

  it("requires the production asset path and reviewed login rate-limit policies", () => {
    const wrongAssets = validConfig();
    wrongAssets.assets.directory = "../other-dist";
    expect(() => validateDeploymentConfig(wrongAssets, input)).toThrow("production web build");

    const wrongSourcePolicy = validConfig();
    wrongSourcePolicy.ratelimits[0].simple.limit = 200;
    expect(() => validateDeploymentConfig(wrongSourcePolicy, input)).toThrow("20-request/60-second");

    const wrongAccountPolicy = validConfig();
    wrongAccountPolicy.ratelimits[1].simple.period = 10;
    expect(() => validateDeploymentConfig(wrongAccountPolicy, input)).toThrow("5-request/60-second");
  });

  it("rejects tracked placeholders and reused rate-limit identities", () => {
    const database = validConfig();
    database.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000";
    expect(() => validateDeploymentConfig(database, input)).toThrow("non-placeholder database ID");

    const rateLimits = validConfig();
    rateLimits.ratelimits[0].namespace_id = "1001";
    expect(() => validateDeploymentConfig(rateLimits, input)).toThrow("replace the tracked placeholders");

    rateLimits.ratelimits[0].namespace_id = "2002";
    expect(() => validateDeploymentConfig(rateLimits, input)).toThrow("positive, distinct");
  });

  it("fails with intentional errors instead of leaking parser details", () => {
    expect(() => validateDeploymentConfig({}, input)).toThrow(DeployConfigError);
    expect(() => validateDeploymentConfig(validConfig(), { ...input, defaultEventSlug: "Not A Slug" }))
      .toThrow("normalized lowercase slug");
  });

  it("parses only an ignored regular Wrangler config", async () => {
    const accepted = configFixture();
    await expect(runDeployConfigPreflight({
      apiRoot: accepted.root,
      config: accepted.filename,
      ...input,
    })).resolves.toMatchObject({ defaultEventSlug: "community-conf" });

    const tracked = configFixture({ filename: "wrangler.jsonc", ignored: false });
    await expect(runDeployConfigPreflight({
      apiRoot: tracked.root,
      config: tracked.filename,
      ...input,
    })).rejects.toThrow("must be ignored by Git");

    await expect(runDeployConfigPreflight({
      apiRoot: tracked.root,
      config: "../outside.jsonc",
      ...input,
    })).rejects.toThrow("must remain under apps/api");
  });

  it("distinguishes a missing Git worktree from a config that is not ignored", async () => {
    const outsideWorktree = configFixture({ repository: false });
    await expect(runDeployConfigPreflight({
      apiRoot: outsideWorktree.root,
      config: outsideWorktree.filename,
      ...input,
    })).rejects.toThrow(
      "Git must be available and apps/api must be inside a Git worktree before deploy config can be verified.",
    );
  });

  it("rejects named environments without revealing their names or values", async () => {
    const config = validConfig();
    config.env = {
      production: {
        vars: {
          SOURCE_URL: "https://git.example.org/community/unsafe-fork",
        },
      },
    };
    const fixture = configFixture({
      contents: `// A real JSONC deploy config with a named environment.\n${JSON.stringify(config, null, 2)}\n`,
    });

    const error = await runDeployConfigPreflight({
      apiRoot: fixture.root,
      config: fixture.filename,
      ...input,
    }).then(() => null, (caught) => caught);

    expect(error).toBeInstanceOf(DeployConfigError);
    expect(error.message).toBe(
      "Deploy config must not define named environments; use one ignored config file per deployment environment.",
    );
    expect(error.message).not.toContain("production");
    expect(error.message).not.toContain("unsafe-fork");
  });

  it("rejects a symlink and malformed ignored config", async () => {
    const linked = configFixture();
    writeFileSync(join(linked.root, "outside.jsonc"), JSON.stringify(validConfig()));
    const linkedName = "wrangler.link.local.jsonc";
    symlinkSync(join(linked.root, "outside.jsonc"), join(linked.root, linkedName));
    await expect(runDeployConfigPreflight({
      apiRoot: linked.root,
      config: linkedName,
      ...input,
    })).rejects.toThrow("regular file, not a symbolic link");

    const malformed = configFixture({ contents: "{ not valid jsonc" });
    await expect(runDeployConfigPreflight({
      apiRoot: malformed.root,
      config: malformed.filename,
      ...input,
    })).rejects.toThrow("could not be parsed as valid Wrangler JSONC");
  });

  it("keeps every configured identifier out of CLI output", async () => {
    const config = validConfig();
    config.name = "private-worker-sentinel";
    config.d1_databases[0].database_id = "99999999-8888-7777-6666-555555555555";
    config.r2_buckets[0].bucket_name = "private-bucket-sentinel";
    config.vars.TURNSTILE_SITE_KEY = "private-site-key-sentinel";
    const fixture = configFixture({ config });
    const messages = [];

    await runDeployConfigCli({
      apiRoot: fixture.root,
      argv: [
        "--",
        "--config", fixture.filename,
        "--source-url", input.expectedSourceUrl,
        "--event-slug", input.defaultEventSlug,
        "--hostnames", input.deployedHostnames.join(","),
      ],
      log: (message) => messages.push(message),
    });

    const output = messages.join("\n");
    for (const forbidden of [
      "private-worker-sentinel", "private-database-sentinel", "private-bucket-sentinel",
      "99999999-8888-7777-6666-555555555555", "private-site-key-sentinel", "2001", "2002",
    ]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain("Deploy config structure is ready.");
  });
});
