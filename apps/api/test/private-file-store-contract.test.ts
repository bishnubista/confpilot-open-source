/**
 * Check, at compile time, that R2 still satisfies the private file store port.
 *
 * `Env.FILES` is declared as `PrivateFileStore`, so nothing in the application
 * ever assigns an `R2Bucket` to that type — TypeScript simply trusts the
 * declaration and the Worker supplies the real binding at runtime. That leaves a
 * gap: the port could drift away from R2's actual shape and nothing would fail
 * until production.
 *
 * The assignments below close it. They are type-level only and compile to nothing
 * meaningful; their entire purpose is to fail `tsc` if the port and the binding
 * stop agreeing. `apps/api/tsconfig.json` includes `test/**\/*.ts`, so this runs
 * in the normal typecheck.
 *
 * Runtime conformance is a separate question, covered by the suite that runs the
 * same behavioural contract against R2 and the filesystem adapter.
 */
import { describe, expect, it } from "vitest";

import type { EmailBinding } from "../src/runtime/email-sender";
import type { PrivateFileObject, PrivateFileStore } from "../src/runtime/private-file-store";

// Fails to compile if R2Bucket no longer satisfies the port.
const r2SatisfiesThePort: (bucket: R2Bucket) => PrivateFileStore = (bucket) => bucket;

// Fails to compile if an R2 object stops carrying the fields the archive reads.
const r2ObjectSatisfiesTheContract: (object: R2ObjectBody) => PrivateFileObject = (object) => object;

// Same guard for the mail binding, which `Env` now names by port rather than by
// its Cloudflare global so the application can compile without Workers types.
// This is the only place left that can notice the two drifting apart.
const sendEmailSatisfiesThePort: (binding: SendEmail) => EmailBinding = (binding) => binding;

describe("private file store contract", () => {
  it("is satisfied by the Cloudflare binding", () => {
    // The assertion that matters is the compile step above; this keeps the file
    // an ordinary test rather than a lint-only artifact, and documents intent.
    expect(typeof r2SatisfiesThePort).toBe("function");
    expect(typeof r2ObjectSatisfiesTheContract).toBe("function");
    expect(typeof sendEmailSatisfiesThePort).toBe("function");
  });
});
