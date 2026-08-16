/**
 * Every configurable environment variable must be documented somewhere findable.
 *
 * The hosting audit found `SOURCE_URL` declared in `Env` and validated by the
 * deploy preflight, but present in neither `.dev.vars.example` nor the Worker
 * `vars` block — so an operator following the examples shipped without it. That
 * is not a one-off: nothing checked, so the next variable would go the same way.
 *
 * This asserts the general property instead of listing names. `Env` is the source
 * of truth for what the application reads; an optional string field is
 * configuration, while a binding (database, bucket, limiter, email) is wiring and
 * is exempt because it is declared in `wrangler.jsonc` rather than set as a value.
 *
 * The interface is read through the TypeScript parser rather than a regex. A
 * pattern over the source text silently stops matching when a field is
 * reformatted, wrapped in a doc comment, or written as `string | undefined` —
 * and a documentation check that quietly matches nothing is worse than none.
 */
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const typesPath = new URL("../src/types.ts", import.meta.url);

function readEnvConfigNames() {
  const source = ts.createSourceFile(
    "types.ts",
    readFileSync(typesPath, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );

  const env = source.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "Env",
  );
  if (!env) throw new Error("Env interface not found in src/types.ts");

  return env.members
    .filter((member) => ts.isPropertySignature(member) && member.questionToken && isStringy(member.type))
    .map((member) => member.name.getText(source));
}

/** `string`, or a union that is only `string` and `undefined`. */
function isStringy(type) {
  if (!type) return false;
  if (type.kind === ts.SyntaxKind.StringKeyword) return true;
  if (!ts.isUnionTypeNode(type)) return false;
  return type.types.every(
    (member) => member.kind === ts.SyntaxKind.StringKeyword || member.kind === ts.SyntaxKind.UndefinedKeyword,
  );
}

function readDocumentedNames() {
  const example = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
  const documented = new Set(
    example.split("\n").map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1]).filter(Boolean),
  );
  // A value fixed at deploy time may live in the Worker vars block instead.
  const worker = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  );
  for (const name of Object.keys(worker.vars ?? {})) documented.add(name);
  return documented;
}

describe("environment documentation", () => {
  it("documents every configurable variable the application reads", () => {
    const documented = readDocumentedNames();
    const undocumented = readEnvConfigNames().filter((name) => !documented.has(name));

    expect(undocumented, "add these to .dev.vars.example or wrangler.jsonc vars").toEqual([]);
  });

  it("actually reads the interface, so the check cannot pass vacuously", () => {
    // A parse that returned nothing would make the assertion above trivially
    // true. Naming variables that must be present catches that, and catches a
    // rename that silently drops one from the check.
    const names = readEnvConfigNames();
    expect(names).toEqual(expect.arrayContaining([
      "SOURCE_URL",
      "CLIENT_IP_SOURCE",
      "TURNSTILE_SECRET_KEY",
      "EMAIL_DELIVERY_ENABLED",
    ]));
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  it("counts bindings as wiring rather than configuration", () => {
    // DB, FILES and the limiters are ports supplied by the host, not values an
    // operator sets, so they must not be demanded of .dev.vars.example.
    const names = readEnvConfigNames();
    for (const binding of ["DB", "FILES", "LOGIN_SOURCE_RATE_LIMITER", "LOGIN_ACCOUNT_RATE_LIMITER", "EMAIL"]) {
      expect(names, `${binding} is a binding, not configuration`).not.toContain(binding);
    }
  });
});
