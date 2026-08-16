/**
 * Exercise the scope guard against a throwaway repository.
 *
 * The guard reads real git state, so it is driven as a CLI here rather than by
 * importing pieces of it. That also tests the thing that actually ships: the exit
 * code, which is what a CI step reacts to.
 *
 * Each test gets its own repository and creates every file it depends on, so a
 * single test run with `--test-name-pattern` behaves the same as a full run.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const guard = fileURLToPath(new URL("./check-scope.mjs", import.meta.url));
let repository;

function git(...args) {
  execFileSync("git", args, { cwd: repository, stdio: "pipe" });
}

function write(relativePath, contents) {
  const absolute = join(repository, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function runGuard(...args) {
  return spawnSync(process.execPath, [guard, ...args], { cwd: repository, encoding: "utf8" });
}

describe("check-scope", () => {
  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), "check-scope-"));
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    write("src/kept.ts", "export const kept = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
  });

  afterEach(() => rmSync(repository, { force: true, recursive: true }));

  it("passes when every change is inside the allowlist", () => {
    write("src/kept.ts", "export const kept = 2;\n");
    const result = runGuard("--base", "HEAD", "--allow", "src/**");
    assert.equal(result.status, 0, result.stderr);
  });

  it("fails when a change falls outside the allowlist", () => {
    write("src/kept.ts", "export const kept = 2;\n");
    const result = runGuard("--base", "HEAD", "--allow", "docs/**");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the declared scope/);
  });

  it("sees untracked files, which git diff alone would miss", () => {
    write("src/brand-new.ts", "export const added = 1;\n");
    const result = runGuard("--base", "HEAD", "--allow", "src/kept.ts");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /brand-new\.ts is outside the declared scope/);
  });

  it("counts a new export as added surface under --pure", () => {
    write("src/brand-new.ts", "export const added = 1;\n");
    const result = runGuard("--base", "HEAD", "--pure", "--allow", "src/**");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not add public surface/);
  });

  it("allows a change that only removes exports under --pure", () => {
    write("src/kept.ts", "const internal = 1;\nexport { internal };\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "two exports");
    write("src/kept.ts", "const internal = 1;\n");
    const result = runGuard("--base", "HEAD", "--pure", "--allow", "src/**");
    assert.equal(result.status, 0, result.stderr);
  });

  it("refuses an invariant file by default", () => {
    write("apps/web/public/_headers", "/*\n  X-Test: 1\n");
    const result = runGuard("--base", "HEAD", "--allow", "**");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not refactor-safe/);
  });

  it("permits an invariant file when the change claims it with --owns", () => {
    write("apps/web/public/_headers", "/*\n  X-Test: 1\n");
    const result = runGuard("--base", "HEAD", "--allow", "**", "--owns", "apps/web/public/_headers");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /explicit --owns claim/);
  });

  it("does not let --owns excuse an unrelated invariant", () => {
    write("apps/web/public/_headers", "/*\n  X-Test: 1\n");
    write("apps/api/migrations/0001_test.sql", "SELECT 1;\n");
    const result = runGuard("--base", "HEAD", "--allow", "**", "--owns", "apps/web/public/_headers");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /migrations\/0001_test\.sql/);
  });
});
