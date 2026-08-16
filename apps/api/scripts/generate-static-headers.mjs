/**
 * Write `apps/web/public/_headers` from the shared policy.
 *
 * The generated file stays committed rather than being produced at build time,
 * so a Cloudflare deploy needs no extra step and the policy is reviewable in a
 * diff. `test/static-headers.test.mjs` fails if the two ever disagree, which is
 * what stops the committed copy from silently drifting.
 *
 *   node scripts/generate-static-headers.mjs
 *   node scripts/generate-static-headers.mjs --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderStaticHeadersFile } from "../src/runtime/security-headers.ts";

const target = new URL("../../web/public/_headers", import.meta.url);
const rendered = renderStaticHeadersFile();
const checkOnly = process.argv.includes("--check");

const current = (() => {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
})();

if (current === rendered) {
  console.log("_headers matches the shared policy.");
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `${fileURLToPath(target)} does not match the shared policy in src/runtime/security-headers.ts.\n` +
    "Run `node scripts/generate-static-headers.mjs` and commit the result.",
  );
  process.exit(1);
}

writeFileSync(target, rendered);
console.log(`Wrote ${fileURLToPath(target)}.`);
