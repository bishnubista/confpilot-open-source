# AGENTS.md

Instructions for AI coding agents working in this repository. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) first; this file is the machine-oriented summary plus the rules that must not be inferred.

## What this project is

ConfPilot runs a conference program from CFP to published schedule: proposals, review, decisions, acceptance, speaker readiness, scheduling, publication, and public embeds. One Cloudflare Worker serves a React SPA and a Hono API from the same origin, backed by D1 (relational) and private R2 (files).

The product promise is that proposal data moves through the whole lifecycle from one source of truth. Accepting a submission creates or updates the downstream speaker, session, tasks, and audit records without copying data into a second module.

## Where code lives

Start at `apps/api/src/app/feature-manifest.ts`. It names every lifecycle module, what it owns, and where it mounts — the fastest path from a behaviour to its code.

```text
apps/api/src/
  app/          composition root, feature manifest, platform routes, agent manifest
  runtime/      ports for external capabilities
  features/     cfp, review, decisions, agenda, publication, speakers
  auth.ts auth-routes.ts http.ts request-safety.ts types.ts password.ts
apps/api/migrations/   ordered SQL, append-only
apps/api/scripts/      operator and verification helpers (inspect before use)
apps/web/src/          React SPA
packages/contracts/    Zod schemas shared by both sides
```

## Before modifying anything

- Verify the repository root, current worktree, branch, upstream, exact HEAD, and dirty state.
- Preserve all pre-existing changes. Never overwrite, stash, move, or clean another contributor's work merely to obtain a clean tree.
- When multiple worktrees or agents are in use, assign exactly one writable owner to each worktree. Other participants must remain read-only or work in a separate worktree.
- For long-running work, keep a concise checkpoint in an ignored scratch area with the worktree, branch, HEAD, owner, dirty state, completed verification, unresolved risks, and next bounded action.
- Keep each branch scoped to one coherent behavior or migration sequence. Finish it as merged, explicitly deferred with a recoverable handoff, or intentionally abandoned without destroying unpreserved work.

## Rules that override default behaviour

**Never weaken these.** They are enforced in more than one place on purpose; if a change makes a test fail, the test is usually right.

- Every query and mutation is scoped by event **and** role. SQLite triggers re-check event roles independently of route middleware — satisfying only the middleware is not sufficient.
- Accepting the same submission twice must not duplicate downstream records.
- Public content must be approved, scheduled, and belong to a published event.
- Private R2 objects are served only through authorization-checked routes. Never expose a bucket URL or public custom domain.
- Optional integrations fail closed. A missing captcha configuration disables public registration; it does not skip verification.
- The API and SPA share one origin so cookies need no CORS design. Do not introduce a cross-origin split.
- Migrations are append-only. Never edit or renumber a migration that has reached a shared environment; add a new one.
- Feature modules must not import each other. Lift shared logic to the root-level modules or `runtime/`.
- External capabilities go through `runtime/`. Do not reach for `env.FILES` or a captcha provider from feature code.
- `featureManifest` order is behaviour. Hono matches in registration order and several modules declare overlapping `/api` patterns; re-run API tests after reordering.
- Every route carries an entry in `app/agent-manifest.ts`. Adding, removing, or renaming a route without updating the catalog fails `test/agent-manifest.test.ts`, which reconciles it against the composed router in both directions.

## Local setup that actually works

The seed contains **no credentials**, so seeding alone leaves an instance nobody can sign in to. Load demo data, then provision an account:

```bash
pnpm install
test -e apps/api/.dev.vars || cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm --filter @confpilot/api db:migrate:local
pnpm --filter @confpilot/api db:seed:local
# then follow the db:prepare-member steps in CONTRIBUTING.md
pnpm dev
```

`db:prepare-bootstrap` is for installing a **new empty** instance and fails on a seeded database. `db:prepare-member` adds an account to an instance that already exists. Do not substitute one for the other.

## Verification

Verification depth follows risk and affected boundaries, not feature count.

- While iterating, run the narrowest deterministic tests that exercise the changed behavior. Do not rerun the complete repository gate after every small edit.
- Before a code change is merge-ready, run the complete gate below on the exact HEAD, locally or through trusted CI for that exact commit. A focused test result alone is not a merge gate.
- Run localhost browser validation for changed user-visible or cross-layer journeys. Exercise the affected happy path and highest-risk failure boundary; do not automatically replay every product workflow.
- Run complete cross-role lifecycle E2E when a release materially changes the CFP-to-publication lifecycle, authentication or authorization across that lifecycle, shared migrations that affect it, or when the user explicitly requests it.
- Report every check actually run, every check intentionally skipped and why, and anything that remains unverified. If a suite fails, quote the relevant output; never describe an unrun check as passing.

Complete merge gate:

```bash
confpilot_source_url="https://git.example.org/your-account/confpilot"
pnpm run check
pnpm test
VITE_SOURCE_URL="$confpilot_source_url" pnpm build
```

Replace the example with the canonical public HTTP(S) source URL for the current clone. A fork or modified build must not advertise the upstream repository as its Corresponding Source.

For a deployed build, also perform the read-only source-offer verification in [docs/self-hosting/agent-install.md](docs/self-hosting/agent-install.md#9-verify): confirm that `/llms.txt` and the public program link expose the same exact Corresponding Source URL before reporting the deployment verified.

### Independent adversarial review

- Decide once per bounded reviewable diff whether independent review is warranted. Use it for authentication, security or privacy, migrations, external-AI or outbound-message boundaries, destructive changes, public contracts, architecture, ambiguous high-cost decisions, and release readiness.
- Skip it for narrow well-tested fixes, mechanical refactors, routine documentation or configuration, formatting, and read-only investigation unless material risk emerges.
- Use an available human or automated review surface; do not require contributors to use a particular vendor or proprietary client.
- Send a compact, read-only packet containing the goal, exact diff, worktree, branch, HEAD, verification already run, known risks, and specific questions. Reproduce every material finding locally before changing code.
- Re-review only when remediation materially changes the reviewed security, privacy, migration, architecture, external-effect, or public-contract boundary. Independent review is advisory, and the absence of a verdict is not itself a defect unless review was selected as an explicit gate for that change.

## Deployment and hosted verification

- Deployment requires explicit authorization for the exact Cloudflare mutation. Deploy only an exact reviewed commit that passed the complete merge gate, and record the commit SHA, relevant configuration, currently deployed Worker version, and rollback target.
- For migration-bearing releases, use backward-compatible append-only migrations and record a forward-fix or recovery plan. Do not assume reverting the Worker also reverts D1 schema or data.
- After every deployment, verify health, routing, `/llms.txt` and the public Corresponding Source link, and unauthorized access to private resources. Verify authentication and session sanity when auth changed or is newly enabled, and database readiness when migrations changed.
- For the changed feature, verify one representative hosted happy path and its highest-risk failure boundary. Run the complete hosted lifecycle only when the release materially affects that lifecycle or when explicitly requested.
- Local success, a passing test suite, a synthetic-provider check, or provider acceptance must not be described as deployed behavior, inbox delivery, or production verification.

## Release readiness

Finishing the project does not mean merging every historical branch. Reconcile existing work first and merge only changes that advance a current completion gate.

A completion claim requires current evidence that:

- A fresh, non-seed proposal completes the real CFP, review, decision, acceptance, speaker readiness, scheduling, publication, and public embed lifecycle.
- Organizer, reviewer, speaker, and public views enforce event and role boundaries, and reloaded UI, API state, and public output agree without seed-only, static, or local-storage substitutes.
- Authentication, email, uploads, AI, and other optional integrations either have current round-trip proof for the enabled configuration or remain visibly fail-closed.
- The complete merge gate, required browser or lifecycle evidence, source-offer verification, and release review pass on the exact candidate commit.
- Every active branch or dirty worktree is merged, explicitly deferred with an owner and recoverable handoff, or intentionally abandoned without loss of unpreserved work.

## Never do these autonomously

These are not style preferences. They change billing, public state, or credentials, and require explicit human authorization for the specific operation:

- Any remote Cloudflare mutation: `wrangler deploy`, remote `d1 execute`, remote migrations, R2 writes, DNS or account settings.
- Enabling paid plans or anything that changes billing.
- Applying seed data to a shared or production database.
- Committing credentials, account identifiers, private URLs, real attendee data, or local filesystem paths.
- Choosing or adding a software license. See "Licensing" below.
- Deleting or rewriting migrations, or force-pushing shared branches.

The documented operator helpers in `apps/api/scripts/` are intended to be offline artifact generators, but inspect the exact script and invocation before trusting that boundary. Only a helper that performs no network or database mutation and writes an inspectable `0600` artifact under an ignored directory may run without remote-mutation authorization. Generating such an artifact is local and recoverable; **applying** one to a remote database is not.

## Licensing

ConfPilot is **AGPL-3.0-or-later** (see `LICENSE`). Do not relicense, add a second license, dual-license, or change the copyright holder. That is the owner's decision, and after outside contributions are merged it is no longer unilaterally theirs to make.

Project contribution policy is documented in [`CONTRIBUTING.md`](CONTRIBUTING.md): contributions are accepted inbound-equals-outbound, commits should be signed off (`git commit -s`), and the complete local gate includes the dependency license audit. Do not introduce a dependency whose license fails that reviewed compatibility check.

The AGPL's section 13 source offer is surfaced in the public program footer and in `/llms.txt`, driven by `VITE_SOURCE_URL` and `SOURCE_URL`. Production builds fail when `VITE_SOURCE_URL` is missing or invalid. Do not remove or hard-code those values.

## Truthfulness

Docs in this repo deliberately state what has **not** been verified. Preserve that. Do not upgrade "pre-release", "not independently tested", or "intended" into claims of production readiness, provider neutrality, or guaranteed delivery. If you add a capability, describe exactly what was tested and what was not.
