import { execFileSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

import { runDeployConfigPreflight } from "../scripts/validate-deploy-config.mjs";
import {
  AgentInstallConfigError,
  agentInstallResourceCommands,
  prepareAgentInstallConfig,
  renderWranglerConfig,
  runAgentInstallConfigCli,
  setAgentInstallConfigD1Id,
  setAgentInstallConfigVars,
} from "../scripts/agent-install-config.mjs";

const temporaryRoots = [];

const validPlan = {
  workerName: "confpilot",
  d1Name: "confpilot-db",
  r2Name: "confpilot-files",
  rateLimitSourceId: "2001",
  rateLimitAccountId: "2002",
  calendarUidDomain: "calendar.example.org",
  sourceUrl: "https://git.example.org/operator/confpilot",
};

const trackedTemplate = {
  name: "confpilot",
  main: "src/index.ts",
  compatibility_date: "2026-08-06",
  observability: { enabled: true, head_sampling_rate: 1 },
  limits: { cpu_ms: 1000 },
  assets: {
    directory: "../web/dist",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api", "/api/*", "/llms.txt"],
  },
  d1_databases: [{
    binding: "DB", database_name: "confpilot-db",
    database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations",
  }],
  r2_buckets: [{ binding: "FILES", bucket_name: "confpilot-files" }],
  ratelimits: [
    { name: "LOGIN_SOURCE_RATE_LIMITER", namespace_id: "1001", simple: { limit: 20, period: 60 } },
    { name: "LOGIN_ACCOUNT_RATE_LIMITER", namespace_id: "1002", simple: { limit: 5, period: 60 } },
  ],
};

const validStructural = {
  main: "src/index.ts", compatibilityDate: "2026-08-06",
  observability: { enabled: true, head_sampling_rate: 1 }, limits: { cpu_ms: 1000 },
  assetsDirectory: "../web/dist", assetsBinding: "ASSETS", notFoundHandling: "single-page-application",
  workerFirstPaths: ["/api", "/api/*", "/llms.txt"], d1Binding: "DB", d1MigrationsDir: "migrations",
  r2Binding: "FILES", rateLimitSourceName: "LOGIN_SOURCE_RATE_LIMITER", rateLimitSourcePolicy: { limit: 20, period: 60 },
  rateLimitAccountName: "LOGIN_ACCOUNT_RATE_LIMITER", rateLimitAccountPolicy: { limit: 5, period: 60 },
};

const validEnv = {
  workerName: "confpilot", d1Name: "confpilot-db", d1Id: "00000000-0000-0000-0000-000000000000",
  r2Name: "confpilot-files", rateLimitSourceId: "2001", rateLimitAccountId: "2002",
  vars: {
    TURNSTILE_SITE_KEY: "key", TURNSTILE_ALLOWED_HOSTNAMES: "cfp.example.org",
    CALENDAR_UID_DOMAIN: "calendar.example.org", SOURCE_URL: "https://git.example.org/operator/confpilot",
  },
};

function fixtureRoot({ initializeGit = true, gitignore = ".wrangler/\nwrangler.*.local.jsonc\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "confpilot-agent-install-config-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".wrangler"));
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(trackedTemplate));
  writeFileSync(join(root, ".gitignore"), gitignore);
  if (initializeGit) execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function writePlan(root, value = validPlan, mode = 0o600) {
  const path = join(root, ".wrangler", "install-plan.json");
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(value), { mode });
  return path;
}

/** Parse a generated JSONC file the same way the production code and Wrangler itself do. */
function parseConfig(root, filename) {
  return unstable_readConfig({ config: join(root, filename) }, { hideWarnings: true });
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe("agent install config generator", () => {
  it("writes Section 2's config with fixed structural fields and a placeholder D1 id, no vars yet", async () => {
    const root = fixtureRoot();
    writePlan(root);
    const result = await prepareAgentInstallConfig({
      apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc",
    });
    expect(result.output).toBe("wrangler.production.local.jsonc");
    const text = readFileSync(join(root, result.output), "utf8");
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/undefined/);
    // unstable_readConfig always resolves `main` to an absolute path on read, even when the
    // file on disk holds the portable relative string, so assert the literal text instead.
    expect(text).toContain('"main": "src/index.ts"');

    const parsed = parseConfig(root, result.output);
    expect(parsed.name).toBe("confpilot");
    expect(parsed.d1_databases).toEqual([expect.objectContaining({
      database_name: "confpilot-db", database_id: "00000000-0000-0000-0000-000000000000",
    })]);
    expect(parsed.r2_buckets).toEqual([expect.objectContaining({ bucket_name: "confpilot-files" })]);
    expect(parsed.ratelimits).toEqual([
      expect.objectContaining({ name: "LOGIN_SOURCE_RATE_LIMITER", namespace_id: "2001" }),
      expect.objectContaining({ name: "LOGIN_ACCOUNT_RATE_LIMITER", namespace_id: "2002" }),
    ]);
    expect(Object.keys(parsed.vars ?? {})).toHaveLength(0);

    const mode = statSync(join(root, result.output)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects an output filename that is not covered by .gitignore, even when the plan is", async () => {
    const root = fixtureRoot({ gitignore: ".wrangler/\n" });
    writePlan(root);
    await expect(prepareAgentInstallConfig({
      apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc",
    })).rejects.toThrow("must be ignored by Git");
  });

  it("refuses to overwrite an existing config", async () => {
    const root = fixtureRoot();
    writePlan(root);
    await prepareAgentInstallConfig({ apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc" });
    await expect(prepareAgentInstallConfig({
      apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc",
    })).rejects.toThrow("refusing to overwrite");
  });

  it("requires the plan to be Git-ignored and mode 0600", async () => {
    const unignored = fixtureRoot({ gitignore: "wrangler.*.local.jsonc\n" });
    writePlan(unignored);
    await expect(prepareAgentInstallConfig({
      apiRoot: unignored, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc",
    })).rejects.toThrow("must be ignored by Git");

    const wrongMode = fixtureRoot();
    const path = writePlan(wrongMode);
    chmodSync(path, 0o644);
    await expect(prepareAgentInstallConfig({
      apiRoot: wrongMode, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc",
    })).rejects.toThrow("0600");
  });

  it.each([
    ["workerName", { ...validPlan, workerName: "Not Valid" }],
    ["rateLimitSourceId placeholder", { ...validPlan, rateLimitSourceId: "1001" }],
    ["duplicate rate-limit ids", { ...validPlan, rateLimitAccountId: validPlan.rateLimitSourceId }],
    ["calendarUidDomain", { ...validPlan, calendarUidDomain: "not a host" }],
    ["sourceUrl", { ...validPlan, sourceUrl: "not-a-url" }],
    ["extra key", { ...validPlan, extra: "nope" }],
  ])("rejects an invalid plan (%s)", async (_label, plan) => {
    const root = fixtureRoot();
    writePlan(root, plan);
    await expect(prepareAgentInstallConfig({
      apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc",
    })).rejects.toThrow(AgentInstallConfigError);
  });

  it("rejects an output path that is not a bare wrangler.<label>.local.jsonc filename", async () => {
    const root = fixtureRoot();
    writePlan(root);
    await expect(prepareAgentInstallConfig({
      apiRoot: root, plan: ".wrangler/install-plan.json", output: "../escape.jsonc",
    })).rejects.toThrow("bare filename");
    await expect(prepareAgentInstallConfig({
      apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.jsonc",
    })).rejects.toThrow("bare filename");
  });

  it("prints the exact Section 3 resource commands without executing anything", async () => {
    const root = fixtureRoot();
    writePlan(root);
    const lines = await agentInstallResourceCommands({ apiRoot: root, plan: ".wrangler/install-plan.json" });
    expect(lines.some((line) => line.startsWith("[GATE]"))).toBe(true);
    expect(lines).toContain("pnpm --dir apps/api exec wrangler d1 create confpilot-db");
    expect(lines).toContain("pnpm --dir apps/api exec wrangler r2 bucket create confpilot-files --storage-class Standard");
  });

  it("patches the returned D1 id (Section 3) while preserving everything else", async () => {
    const root = fixtureRoot();
    writePlan(root);
    await prepareAgentInstallConfig({ apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc" });
    const result = await setAgentInstallConfigD1Id({
      apiRoot: root, config: "wrangler.production.local.jsonc", id: "11111111-2222-3333-4444-555555555555",
    });
    const parsed = parseConfig(root, result.output);
    expect(parsed.d1_databases[0].database_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(parsed.name).toBe("confpilot");
    expect(Object.keys(parsed.vars ?? {})).toHaveLength(0);
  });

  it.each([
    ["the tracked placeholder", "00000000-0000-0000-0000-000000000000"],
    ["a malformed id", "not-a-uuid"],
  ])("rejects %s as a D1 id", async (_label, id) => {
    const root = fixtureRoot();
    writePlan(root);
    await prepareAgentInstallConfig({ apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc" });
    await expect(setAgentInstallConfigD1Id({ apiRoot: root, config: "wrangler.production.local.jsonc", id }))
      .rejects.toThrow();
  });

  it("adds the full Section 4 vars block and preserves the patched D1 id", async () => {
    const root = fixtureRoot();
    writePlan(root);
    await prepareAgentInstallConfig({ apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc" });
    await setAgentInstallConfigD1Id({ apiRoot: root, config: "wrangler.production.local.jsonc", id: "11111111-2222-3333-4444-555555555555" });
    const result = await setAgentInstallConfigVars({
      apiRoot: root,
      config: "wrangler.production.local.jsonc",
      plan: ".wrangler/install-plan.json",
      turnstileSiteKey: "0x4AAAAAAAtestproductionkey00",
      allowedHostnames: "cfp.example.org,www.cfp.example.org",
    });
    const text = readFileSync(join(root, result.output), "utf8");
    expect(text).not.toMatch(/undefined/);

    const parsed = parseConfig(root, result.output);
    expect(parsed.vars).toEqual({
      TURNSTILE_SITE_KEY: "0x4AAAAAAAtestproductionkey00",
      TURNSTILE_ALLOWED_HOSTNAMES: "cfp.example.org,www.cfp.example.org",
      CALENDAR_UID_DOMAIN: "calendar.example.org",
      SOURCE_URL: "https://git.example.org/operator/confpilot",
    });
    expect(parsed.d1_databases[0].database_id).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("rejects duplicate or malformed allowed hostnames", async () => {
    const root = fixtureRoot();
    writePlan(root);
    await prepareAgentInstallConfig({ apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc" });
    await expect(setAgentInstallConfigVars({
      apiRoot: root, config: "wrangler.production.local.jsonc", plan: ".wrangler/install-plan.json",
      turnstileSiteKey: "key", allowedHostnames: "cfp.example.org,cfp.example.org",
    })).rejects.toThrow("unique");
    await expect(setAgentInstallConfigVars({
      apiRoot: root, config: "wrangler.production.local.jsonc", plan: ".wrangler/install-plan.json",
      turnstileSiteKey: "key", allowedHostnames: "https://cfp.example.org",
    })).rejects.toThrow("normalized hostname");
  });

  it("refuses a config path outside apps/api or that is a symlink", async () => {
    const root = fixtureRoot();
    writePlan(root);
    await prepareAgentInstallConfig({ apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc" });
    symlinkSync(join(root, "wrangler.production.local.jsonc"), join(root, "wrangler.linked.local.jsonc"));
    await expect(setAgentInstallConfigD1Id({
      apiRoot: root, config: "wrangler.linked.local.jsonc", id: "11111111-2222-3333-4444-555555555555",
    })).rejects.toThrow("symbolic link");
    await expect(setAgentInstallConfigD1Id({
      apiRoot: root, config: "../outside.jsonc", id: "11111111-2222-3333-4444-555555555555",
    })).rejects.toThrow("bare filename");
  });

  it("produces a config that the existing deploy preflight accepts unchanged", async () => {
    const root = fixtureRoot();
    writePlan(root);
    await prepareAgentInstallConfig({ apiRoot: root, plan: ".wrangler/install-plan.json", output: "wrangler.production.local.jsonc" });
    await setAgentInstallConfigD1Id({ apiRoot: root, config: "wrangler.production.local.jsonc", id: "11111111-2222-3333-4444-555555555555" });
    await setAgentInstallConfigVars({
      apiRoot: root,
      config: "wrangler.production.local.jsonc",
      plan: ".wrangler/install-plan.json",
      turnstileSiteKey: "0x4AAAAAAAtestproductionkey00",
      allowedHostnames: "cfp.example.org,www.cfp.example.org",
    });

    await expect(runDeployConfigPreflight({
      apiRoot: root,
      config: "wrangler.production.local.jsonc",
      expectedSourceUrl: "https://git.example.org/operator/confpilot",
      defaultEventSlug: "community-conf",
      deployedHostnames: ["cfp.example.org", "www.cfp.example.org"],
    })).resolves.toMatchObject({ defaultEventSlug: "community-conf" });
  });

  it("keeps generated identifiers out of CLI log output", async () => {
    const root = fixtureRoot();
    writePlan(root, { ...validPlan, workerName: "private-worker-sentinel", d1Name: "private-db-sentinel" });
    const logs = [];
    await runAgentInstallConfigCli({
      apiRoot: root,
      argv: ["init", "--plan", ".wrangler/install-plan.json", "--output", "wrangler.production.local.jsonc"],
      log: (message) => logs.push(message),
    });
    const output = logs.join("\n");
    expect(output).not.toContain("private-worker-sentinel");
    expect(output).not.toContain("private-db-sentinel");
    expect(output).toContain("Section 2");
  });

  it("rejects an unknown subcommand and missing flags with intentional errors", async () => {
    const root = fixtureRoot();
    await expect(runAgentInstallConfigCli({ apiRoot: root, argv: ["nonsense"], log: () => {} }))
      .rejects.toThrow(AgentInstallConfigError);
    await expect(runAgentInstallConfigCli({ apiRoot: root, argv: ["init", "--plan"], log: () => {} }))
      .rejects.toThrow(/Missing value/);
  });

  it.each([
    "main", "compatibilityDate", "observability", "limits", "assetsDirectory", "assetsBinding",
    "notFoundHandling", "workerFirstPaths", "d1Binding", "d1MigrationsDir", "r2Binding",
    "rateLimitSourceName", "rateLimitSourcePolicy", "rateLimitAccountName", "rateLimitAccountPolicy",
  ])("rejects rendering when the structural field %s is missing", (key) => {
    const structural = { ...validStructural, [key]: undefined };
    expect(() => renderWranglerConfig(structural, validEnv)).toThrow(AgentInstallConfigError);
  });

  it.each([
    "TURNSTILE_SITE_KEY", "TURNSTILE_ALLOWED_HOSTNAMES", "CALENDAR_UID_DOMAIN", "SOURCE_URL",
  ])("rejects rendering when the vars field %s is missing", (key) => {
    const env = { ...validEnv, vars: { ...validEnv.vars, [key]: undefined } };
    expect(() => renderWranglerConfig(validStructural, env)).toThrow(AgentInstallConfigError);
  });

  it.each([
    "workerName", "d1Name", "d1Id", "r2Name", "rateLimitSourceId", "rateLimitAccountId",
  ])("rejects rendering when the env field %s is missing", (key) => {
    const env = { ...validEnv, [key]: undefined };
    expect(() => renderWranglerConfig(validStructural, env)).toThrow(AgentInstallConfigError);
  });

  it("does not require vars fields when env.vars is null", () => {
    expect(() => renderWranglerConfig(validStructural, { ...validEnv, vars: null })).not.toThrow();
  });

  it("renders no vars block for a null env.vars and a well-formed block otherwise", () => {
    const root = fixtureRoot();
    const structural = {
      main: "src/index.ts", compatibilityDate: "2026-08-06",
      observability: { enabled: true, head_sampling_rate: 1 }, limits: { cpu_ms: 1000 },
      assetsDirectory: "../web/dist", assetsBinding: "ASSETS", notFoundHandling: "single-page-application",
      workerFirstPaths: ["/api", "/api/*", "/llms.txt"], d1Binding: "DB", d1MigrationsDir: "migrations",
      r2Binding: "FILES", rateLimitSourceName: "LOGIN_SOURCE_RATE_LIMITER", rateLimitSourcePolicy: { limit: 20, period: 60 },
      rateLimitAccountName: "LOGIN_ACCOUNT_RATE_LIMITER", rateLimitAccountPolicy: { limit: 5, period: 60 },
    };
    const withoutVars = renderWranglerConfig(structural, {
      workerName: "confpilot", d1Name: "confpilot-db", d1Id: "00000000-0000-0000-0000-000000000000",
      r2Name: "confpilot-files", rateLimitSourceId: "2001", rateLimitAccountId: "2002", vars: null,
    });
    expect(withoutVars).not.toContain("\"vars\"");
    writeFileSync(join(root, "wrangler.without-vars.local.jsonc"), withoutVars);
    expect(() => parseConfig(root, "wrangler.without-vars.local.jsonc")).not.toThrow();

    const withVars = renderWranglerConfig(structural, {
      workerName: "confpilot", d1Name: "confpilot-db", d1Id: "00000000-0000-0000-0000-000000000000",
      r2Name: "confpilot-files", rateLimitSourceId: "2001", rateLimitAccountId: "2002",
      vars: {
        TURNSTILE_SITE_KEY: "key", TURNSTILE_ALLOWED_HOSTNAMES: "cfp.example.org",
        CALENDAR_UID_DOMAIN: "calendar.example.org", SOURCE_URL: "https://git.example.org/operator/confpilot",
      },
    });
    writeFileSync(join(root, "wrangler.with-vars.local.jsonc"), withVars);
    expect(parseConfig(root, "wrangler.with-vars.local.jsonc").vars).toMatchObject({ TURNSTILE_SITE_KEY: "key" });
  });
});
