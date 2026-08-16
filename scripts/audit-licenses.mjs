/**
 * Audit the lockfile-resolved production graph and every installed package.
 *
 * The checked-in THIRD_PARTY_NOTICES.md is generated from the exact production
 * dependency graph that pnpm resolves from pnpm-lock.yaml. Every production
 * package must be installed and must ship a license text. The broader installed
 * graph is also checked for lockfile membership and reviewed-compatible SPDX
 * declarations so development dependencies cannot silently change the
 * project's licensing position.
 *
 *   node scripts/audit-licenses.mjs
 *   node scripts/audit-licenses.mjs --write-notice
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSpdxExpression } from "./spdx-license-expression.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const store = join(repoRoot, "node_modules", ".pnpm");
const lockfilePath = join(repoRoot, "pnpm-lock.yaml");
const noticePath = join(repoRoot, "THIRD_PARTY_NOTICES.md");

const COMPATIBLE = new Set([
  "0BSD", "Apache-2.0", "BlueOak-1.0.0", "BSD-2-Clause", "BSD-3-Clause",
  "CC0-1.0", "CC-BY-4.0", "ISC", "LGPL-3.0-or-later", "MIT", "MIT-0",
  "MPL-2.0", "Python-2.0", "Unlicense", "WTFPL",
]);

function declaredLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type).join(" OR ");
  return null;
}

function isCompatible(expression) {
  try {
    return evaluateSpdxExpression(expression, COMPATIBLE);
  } catch {
    return false;
  }
}

function lockfilePackages(contents) {
  const packages = new Set();
  let inPackages = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages && line && !line.startsWith(" ")) break;
    if (!inPackages) continue;
    const match = line.match(/^  (\S.*):\s*$/);
    if (match) packages.add(match[1].replace(/^'|'$/g, ""));
  }
  if (packages.size === 0) throw new Error("pnpm-lock.yaml has no parseable packages section.");
  return packages;
}

function collectInstalled(base, depth, found) {
  if (depth > 1 || !existsSync(base)) return;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = join(base, entry.name);
    if (entry.name.startsWith("@")) {
      collectInstalled(packagePath, depth + 1, found);
      continue;
    }
    const manifestPath = join(packagePath, "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!pkg.name || !pkg.version) continue;
      const licenseFiles = readdirSync(packagePath, { withFileTypes: true })
        .filter((candidate) => candidate.isFile() && /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(candidate.name))
        .map((candidate) => candidate.name)
        .sort();
      found.set(`${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        version: pkg.version,
        license: declaredLicense(pkg),
        packagePath,
        licenseFiles,
      });
    } catch {
      found.set(relative(repoRoot, packagePath), { license: null, packagePath, licenseFiles: [] });
    }
  }
}

function productionKeys() {
  const output = execFileSync(
    "pnpm",
    ["list", "--json", "--depth", "Infinity", "--prod", "--lockfile-only"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const keys = new Set();
  const visit = (node) => {
    for (const group of ["dependencies", "optionalDependencies"]) {
      for (const [name, dependency] of Object.entries(node[group] ?? {})) {
        const version = String(dependency.version ?? "").replace(/\(.*/, "");
        if (version && !version.startsWith("link:")) keys.add(`${name}@${version}`);
        visit(dependency);
      }
    }
  };
  for (const root of JSON.parse(output)) visit(root);
  if (keys.size === 0) throw new Error("pnpm returned an empty production dependency graph.");
  return [...keys].sort();
}

function indent(text) {
  return text.trimEnd().split(/\r?\n/).map((line) => line ? `    ${line}` : "").join("\n");
}

function generatedNotice(packages, lockfile) {
  const digest = createHash("sha256").update(lockfile).digest("hex");
  const sections = packages.map((pkg) => {
    const texts = pkg.licenseFiles.map((filename) => {
      const licenseText = readFileSync(join(pkg.packagePath, filename), "utf8");
      return `Source file in the installed package: \`${filename}\`\n\n${indent(licenseText)}`;
    });
    return `## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license}\n\n${texts.join("\n\n")}`;
  });
  return `# Third-party notices\n\nThis file is generated by \`node scripts/audit-licenses.mjs --write-notice\` from the production dependency graph resolved from \`pnpm-lock.yaml\`. Do not edit it by hand.\n\nLockfile SHA-256: \`${digest}\`\n\n${sections.join("\n\n---\n\n")}\n`;
}

if (!existsSync(store)) {
  console.error("No pnpm store found. Run `pnpm install --frozen-lockfile` first.");
  process.exit(1);
}
if (!existsSync(lockfilePath)) {
  console.error("pnpm-lock.yaml is missing.");
  process.exit(1);
}

const lockfile = readFileSync(lockfilePath, "utf8");
const locked = lockfilePackages(lockfile);
const installed = new Map();
for (const directory of readdirSync(store)) collectInstalled(join(store, directory, "node_modules"), 0, installed);

const counts = new Map();
const problems = [];
for (const [key, pkg] of installed) {
  if (!locked.has(key)) problems.push(`${key}: installed package is absent from pnpm-lock.yaml`);
  if (!pkg.license) {
    problems.push(`${key}: no license field`);
    continue;
  }
  counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  if (!isCompatible(pkg.license)) {
    problems.push(`${key}: ${pkg.license} is malformed, unsupported, or not on the reviewed-compatible list`);
  }
}

const production = [];
for (const key of productionKeys()) {
  if (!locked.has(key)) problems.push(`${key}: production package is absent from pnpm-lock.yaml`);
  const pkg = installed.get(key);
  if (!pkg) {
    problems.push(`${key}: production package is not installed`);
    continue;
  }
  if (pkg.licenseFiles.length === 0) problems.push(`${key}: production package ships no LICENSE, LICENCE, COPYING, or NOTICE text`);
  production.push(pkg);
}

console.log(`${locked.size} lockfile packages; ${installed.size} installed on this platform; ${production.length} production packages\n`);
for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(5)}  ${license}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} need review:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const expectedNotice = generatedNotice(production, lockfile);
if (process.argv.includes("--write-notice")) {
  writeFileSync(noticePath, expectedNotice);
  console.log(`\nWrote ${relative(repoRoot, noticePath)}.`);
} else if (!existsSync(noticePath) || readFileSync(noticePath, "utf8") !== expectedNotice) {
  console.error("\nTHIRD_PARTY_NOTICES.md is stale. Run `node scripts/audit-licenses.mjs --write-notice` and commit the result.");
  process.exit(1);
}

console.log("\nThe lockfile inventory, compatible declarations, production license texts, and checked-in notice are reproducible.");
