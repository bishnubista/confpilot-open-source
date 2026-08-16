# Cloudflare deployment operations

Status: pre-deployment runbook. Every action that changes billing, remote resources, production data, or DNS requires explicit approval at execution time.

## Deployment shape

ConfPilot runs as one same-origin Cloudflare Worker:

- Vite static assets and the Hono API share the same host.
- D1 is the authoritative relational store and migration history.
- R2 stores private headshots and presentation versions; application routes enforce access.
- two native rate-limit bindings protect public credential endpoints.
- Turnstile protects public speaker registration, with mandatory server-side Siteverify validation.

The preview Worker caps CPU at 1,000 ms per request and samples 100% of invocation logs. The CPU ceiling is a runaway circuit breaker, not a billing control: Cloudflare bills actual CPU consumed. Revisit both settings after measuring preview p99 CPU and diagnosing the release flow; reduce log sampling before sustained production traffic.

## Cost boundary

Workers Paid is the required plan for the credential-authenticated preview. Workers Free has not been certified by a hosted benchmark, so do not infer a specific CPU failure from permissive Node or local Miniflare results. A hosted Paid-plan login smoke test is a release gate. As verified on 2026-08-12, Workers Standard includes 10 million dynamic requests and 30 million CPU milliseconds each month in its $5 minimum; static asset requests are free. Confirm current pricing immediately before enabling billing.

D1 and R2 both include allowances suitable for an early event workload, but usage remains billable above those allowances. Configure billing alerts and review Worker CPU, D1 rows read/written, R2 storage, and R2 operation counts after each evaluation run.

Primary references:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

## Release gates

Before the first remote mutation:

1. Verify the intended Cloudflare identity and confirm the repository branch is clean enough to attribute every deployment input.
2. Obtain approval before enabling Workers Paid or R2 usage billing.
3. Run the full local type, test, and build gates.
4. Run a tracked-file privacy scan for credentials, personal contact details, provider account identifiers, private URLs, and local filesystem paths.
5. Confirm that no production credential or attendee data is present in seed files or build artifacts.
6. Allocate two positive-integer rate-limit namespace identifiers that are unused anywhere else in the target Cloudflare account. Replace the tracked `1001` and `1002` placeholders, require the two target values to differ from each other, and stop if account-wide uniqueness cannot be established. Reusing an identifier, including across Workers, intentionally shares counters.

These gates intentionally use only local evidence and read-only account inspection available before the target resources exist. The complete deploy-config preflight belongs later in the provisioning order, after D1, R2, Turnstile, migrations, and bootstrap have supplied the values it validates. Before the first D1 schema mutation, use the ledger and schema inspection below; before deployment, use both that local preflight and the documented read-only R2 and secret checks.

### D1 migration procedure

Before each remote schema change, query `d1_migrations` and the relevant `sqlite_schema` or `PRAGMA table_info(...)` entries. For `0000_initial.sql`, the ledger must either be absent or have Wrangler's expected schema with no rows. For every later target, the ledger must contain the complete checked-in sequence through the exact predecessor, in order, with no extra rows. The target filename and every table, column, index, or trigger introduced by it must be absent. Stop on any mismatch.

Capture and record the current [D1 Time Travel bookmark](https://developers.cloudflare.com/d1/reference/time-travel/) immediately before mutation. A restore overwrites the database in place and therefore requires separate approval. The current retention window is 30 days on Workers Paid and 7 days on Workers Free.

For a migration containing a compound `CREATE TRIGGER ... BEGIN ... END`, do not use remote `d1 migrations apply`: the currently tested Wrangler path can split the trigger body and fail with `incomplete input`. The guarded file-import procedure below works for the complete catalog and is the required clean-install path:

1. From `apps/api`, generate exactly one checked-in migration artifact. Start an empty database with `pnpm db:prepare-remote-migration --migration 0000_initial.sql --predecessor none`. After that artifact is applied and certified, generate the next artifact with the exact checked-in predecessor, for example `pnpm db:prepare-remote-migration --migration 0001_auth_credentials.sql --predecessor 0000_initial.sql`. Repeat one step at a time through the current final migration.

   The helper requires a contiguous local catalog, rejects path-like names and skipped predecessors, performs no network action, and prints an ignored artifact path. The `0000` artifact safely initializes Wrangler's ledger before requiring it to be empty. Every artifact embeds a pre-migration gate that compares the remote ledger's complete name order with the expected catalog prefix, then appends exactly one target ledger row after the unchanged migration SQL. An optional `--output <ignored-relative-path>` argument may override the default ignored path.

   The guard's table-valued `PRAGMA` queries and normalized `sqlite_master` comparison are covered by automated SQLite tests and a repository-pinned Wrangler local-D1 rehearsal. Until one separately approved disposable remote-D1 rehearsal passes, remote compatibility remains unverified: any guard failure must stop closed for the audit in step 3, never trigger a blind retry.

   | Target | Required `--predecessor` |
   | --- | --- |
   | `0000_initial.sql` | `none` |
   | `0001_auth_credentials.sql` | `0000_initial.sql` |
   | `0002_cfp_drafts.sql` | `0001_auth_credentials.sql` |
   | `0003_reviewer_workflow.sql` | `0002_cfp_drafts.sql` |
   | `0004_decision_notifications.sql` | `0003_reviewer_workflow.sql` |
   | `0005_public_embeds.sql` | `0004_decision_notifications.sql` |
   | `0006_speaker_content.sql` | `0005_public_embeds.sql` |
   | `0007_agenda_publication.sql` | `0006_speaker_content.sql` |
   | `0008_workers_password_iterations.sql` | `0007_agenda_publication.sql` |
   | `0009_review_criteria_scoring.sql` | `0008_workers_password_iterations.sql` |
   | `0010_speaker_roster_ingest.sql` | `0009_review_criteria_scoring.sql` |
   | `0011_generic_message_outbox.sql` | `0010_speaker_roster_ingest.sql` |
   | `0012_reviewer_conflicts_recusal.sql` | `0011_generic_message_outbox.sql` |
   | `0013_review_operations.sql` | `0012_reviewer_conflicts_recusal.sql` |
   | `0014_agenda_placement_publication_guard.sql` | `0013_review_operations.sql` |
   | `0015_embed_presentation.sql` | `0014_agenda_placement_publication_guard.sql` |
   | `0016_reviewer_invitations.sql` | `0015_embed_presentation.sql` |
   | `0017_speaker_account_claims.sql` | `0016_reviewer_invitations.sql` |
   | `0018_event_multi_role_memberships.sql` | `0017_speaker_account_claims.sql` |
   | `0019_review_scorecard_corrections.sql` | `0018_event_multi_role_memberships.sql` |
   | `0020_review_round_decision_continuation.sql` | `0019_review_scorecard_corrections.sql` |
   | `0021_review_correction_score_completeness.sql` | `0020_review_round_decision_continuation.sql` |
   | `0022_canceled_message_retention.sql` | `0021_review_correction_score_completeness.sql` |
   | `0023_reviewer_invitation_expiry_compatibility.sql` | `0022_canceled_message_retention.sql` |
   | `0024_integrated_review_hardening.sql` | `0023_reviewer_invitation_expiry_compatibility.sql` |
   | `0025_release_review_guards.sql` | `0024_integrated_review_hardening.sql` |

   Before applying `0024_integrated_review_hardening.sql`, run this read-only preflight. Any returned row means multiple reviewer invitations reference one outbox message and the duplicate relationship must be reviewed before the unique index can be created:

   ```sql
   SELECT outbox_message_id, COUNT(*) AS duplicate_count
   FROM reviewer_invitations
   WHERE outbox_message_id IS NOT NULL
   GROUP BY outbox_message_id
   HAVING COUNT(*) > 1;
   ```

   Before applying `0025_release_review_guards.sql`, verify that the predecessor trigger exists exactly once. Any result other than `1` means the observed schema does not match the expected `0024` state; stop before preparing or applying the artifact:

   ```sql
   SELECT COUNT(*) AS predecessor_trigger_count
   FROM sqlite_master
   WHERE type = 'trigger' AND name = 'speaker_claim_link_guard';
   ```

   Before preparing `0010_speaker_roster_ingest.sql`, run this read-only preflight. It reports counts only, without printing speaker addresses. Any returned row means normalized duplicates must be reviewed and resolved before migration; do not retry the migration blindly.

   ```sql
   SELECT COUNT(*) AS duplicate_email_groups
   FROM (
     SELECT event_id, lower(trim(contact_email)) AS normalized_email
     FROM speakers
     WHERE trim(contact_email) != ''
     GROUP BY event_id, lower(trim(contact_email))
     HAVING COUNT(*) > 1
   )
   HAVING COUNT(*) > 0;
   ```

2. Re-run the remote ledger and target-absence preflight. From `apps/api`, set the target-specific values below, verify that each quoted path exists, and run the final repository-pinned Wrangler command exactly once:

   ```bash
   (
     set -euo pipefail
     confpilot_database="replace-with-target-database"
     confpilot_migration_artifact=".wrangler/remote-migrations/0000_initial.sql"
     confpilot_wrangler_config="wrangler.preview.local.jsonc"

     test "$confpilot_database" != "replace-with-target-database"
     test -f "$confpilot_migration_artifact"
     test -f "$confpilot_wrangler_config"
     node --input-type=module - "$confpilot_wrangler_config" <<'NODE'
   import { readFileSync } from "node:fs";
   import ts from "typescript";

   const configPath = process.argv[2];
   const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
   if (parsed.error) throw new Error("The Wrangler configuration must be valid JSONC.");
   const ids = (parsed.config.ratelimits ?? []).map(({ namespace_id: id }) => String(id));
   if (
     ids.length !== 2 ||
     ids.some((id) => !/^[1-9]\d*$/.test(id) || id === "1001" || id === "1002") ||
     new Set(ids).size !== ids.length
   ) {
     throw new Error("Use two distinct, non-placeholder rate-limit namespace identifiers.");
   }
   NODE
     pnpm exec wrangler d1 execute "$confpilot_database" --remote --file="$confpilot_migration_artifact" --config "$confpilot_wrangler_config"
   )
   ```

   Replace the artifact filename for each exact next migration. Do not run the final command a second time unless the post-failure investigation in the next step explicitly approves a repair.
3. Never retry a failed import blindly. A remote file import is not guaranteed to be atomic and can leave earlier statements committed even when Wrangler reports failure. A failed ledger gate can leave `_confpilot_remote_migration_guard`; a later migration failure can leave some target schema statements without the target ledger row. Re-query the ledger and schema, compare them with the recorded bookmark and artifact, and choose an explicit repair or approved Time Travel restore. Remove a leftover guard only as part of that reviewed repair, after confirming no target statement ran.

   Migration `0018_event_multi_role_memberships.sql` is a forward-only role-model change once any account holds more than one event role. Do not attempt to recreate the former event/user-only unique index as a rollback; it cannot represent valid multi-role rows. If `0018` fails without its ledger row, inspect all six affected objects (`event_memberships_event_user_unique`, `event_memberships_event_user_role_unique`, `speaker_claim_insert_guard`, `speaker_claim_transition_guard`, `reviewer_invitations_insert_guard`, and `reviewer_invitations_transition_guard`). The migration uses idempotent drops/index creation so a reviewed repair may rerun the exact target SQL, but only after confirming the ledger still ends at `0017` and no incompatible manual schema change was made. Prefer an approved Time Travel restore when those conditions cannot be proven. Rolling back only the Worker after multi-role rows exist is unsupported; deploy a forward fix instead.

   Migration `0019_review_scorecard_corrections.sql` adds append-only correction ledgers plus `current_reviews` projections. It does not rewrite existing reviews. If the migration is interrupted before its ledger row is recorded, inspect both correction tables, both current-value views, and all six `review_correction*` triggers before rerunning the exact SQL; its object creation is idempotent for that reviewed recovery path. Once correction rows exist, an older Worker will read the preserved base submissions rather than the latest correction, so Worker-only rollback is not a valid data rollback. Restore the database to a pre-migration point or deploy a forward fix under the normal approval process.

   Migration `0020_review_round_decision_continuation.sql` replaces the assignment and review authorization triggers so a decided proposal can receive additional input only through an explicit named round whose window is open at the write timestamp. It does not change decisions, acceptances, or sessions. If application fails before its ledger row is recorded, inspect `review_assignments_scope_insert` and `reviews_valid_assignment_insert`; the migration's drop-and-create sequence is idempotent for a reviewed rerun. An older Worker will reject this newly valid continuation path, so restore to a pre-migration point or deploy a forward fix rather than rolling back only the Worker.

   Migration `0023_reviewer_invitation_expiry_compatibility.sql` rebuilds `reviewer_invitations` and `reviewer_invitation_acceptances` and must drop six legacy triggers before renaming the old tables. `PRAGMA defer_foreign_keys` defers constraint checks for that transaction; it does not make the guarded remote file import atomic. If application fails without the `0023` ledger row, do not rerun it in place. Inspect `sqlite_master` for both canonical tables and both `_legacy_0023` tables, all six invitation triggers, both invitation indexes, row counts by invitation state, acceptance-receipt counts, `PRAGMA foreign_key_check`, and `PRAGMA quick_check`. Because a partial import can leave data split between old and new tables, use the recorded pre-migration Time Travel bookmark after obtaining destructive-action approval, or prepare a separately reviewed forward repair for the exact observed state. Do not drop a legacy table, copy rows, or recreate triggers ad hoc. If the `0023` ledger row exists but certification fails, treat that as a failed release and choose the same approved restore-or-forward-fix path; rolling back only the Worker does not repair the schema.

   Migration `0024_integrated_review_hardening.sql` creates a unique reviewer-invitation outbox relationship and three new validation triggers. Run the duplicate `reviewer_invitations.outbox_message_id` preflight above before applying it. If application fails without its ledger row, do not rerun the exact file: the guarded import is not atomic. Inspect `reviewer_invitations_outbox_message_unique`, `review_rounds_canonical_window_insert`, `review_rounds_canonical_window_update`, and `review_corrections_complete_scores_insert`, then prepare an explicit statement-by-statement repair for the observed objects or obtain approval for a Time Travel restore.

   Migration `0025_release_review_guards.sql` replaces `speaker_claim_link_guard`; verify the predecessor trigger with the preflight above before applying it. If `DROP TRIGGER` succeeds but `CREATE TRIGGER` or the migration-ledger write fails, do not rerun the artifact blindly. Confirm the ledger and trigger state, then either apply a separately reviewed forward repair that recreates the exact `speaker_claim_link_guard` definition from `0025`, or obtain approval for a Time Travel restore. Do not leave the database accepting unguarded speaker-account link changes.
4. Certify the result before deploying dependent code: the ledger has exactly one new next row with the target filename; every expected schema object and column matches the migration; `PRAGMA foreign_key_check` returns no rows; and `PRAGMA quick_check` returns exactly `ok`. Then verify application health/readiness.

Use ordinary [`d1 migrations apply`](https://developers.cloudflare.com/d1/reference/migrations/) only for migrations proven compatible with that path. Always apply in order and never rewrite a migration that has reached a shared environment. The [`d1 execute`](https://developers.cloudflare.com/d1/wrangler-commands/#d1-execute) command accepts one SQL file through `--file`; keep the generated artifact as the sole input to that invocation.

### R2 release gates

Keep preview and production buckets private. As a read-only release gate, inspect bucket settings and confirm both the public `r2.dev` development URL and every R2 custom domain are disabled; either access path can expose bucket objects independently. Files remain reachable only through the authenticated Worker routes. See Cloudflare's [public bucket access guidance](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Keep preview objects in the default [Standard storage class](https://developers.cloudflare.com/r2/buckets/storage-classes/). Do not add an expiration or storage-transition [lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) for the active `events/` keyspace: active headshots and deliverable versions must not expire or incur early-deletion/retrieval tradeoffs. Revisit storage classes only after measuring access patterns.

Application reads and deletes must continue to use the exact object key held by D1. Defer a separate exact-key D1-to-R2 reconciliation job until operational volume justifies it; do not make broad prefix listing or deletion part of the release path.

## Provisioning order

Use generic resource names in documentation. Copy `apps/api/wrangler.jsonc` to the ignored `apps/api/wrangler.preview.local.jsonc` for provider-generated identifiers and preview-specific resource names. Before any remote command, replace both tracked rate-limit namespace placeholders with distinct positive-integer values that are unused across the target Cloudflare account; do not reuse preview values for production. Run Wrangler from `apps/api` with `--config wrangler.preview.local.jsonc`. Never place provider IDs in the tracked source config.

1. Enable the approved Workers plan.
2. Authenticate Wrangler to the visibly verified account.
3. Create an isolated preview D1 database and put its binding identifier only in the ignored preview config.
4. Create an isolated private preview R2 bucket matching the `FILES` binding in that config.
5. Create a Turnstile widget restricted to the preview and production hostnames.
6. Add `TURNSTILE_SITE_KEY` and `TURNSTILE_ALLOWED_HOSTNAMES` as Worker variables. Add `TURNSTILE_SECRET_KEY` only with Wrangler's secret command or the dashboard secret store.
7. Apply production D1 migrations with the D1 procedure above. Do **not** run `apps/api/seed/seed.sql` or `apps/api/seed/agenda.sql` in production.
8. Generate the first event, owner credential, organizer membership, and CFP configuration with the file-based `db:prepare-bootstrap` flow in `docs/self-hosting/cloudflare.md`. Inspect and apply the generated SQL exactly once to the empty migrated database. Never commit the plaintext input or generated credential artifact.
9. Run the local deploy-config preflight from the repository root with the now-complete ignored config, the exact public source URL intended for the final frontend build, the bootstrapped event slug, and every hostname that will serve this deployment. Then, using the Node version in `.node-version` and the pnpm version in `package.json`, build the deployable web assets with that same source URL and event slug. Do not add an extra `--` before the preflight arguments:

   ```bash
   confpilot_wrangler_config="wrangler.preview.local.jsonc"
   confpilot_source_url="https://git.example.org/operator/confpilot"
   confpilot_event_slug="replace-with-bootstrapped-slug"
   confpilot_hostnames="cfp.example.org,www.cfp.example.org,confpilot.example.workers.dev"

   pnpm --dir apps/api deploy:preflight \
     --config "$confpilot_wrangler_config" \
     --source-url "$confpilot_source_url" \
     --event-slug "$confpilot_event_slug" \
     --hostnames "$confpilot_hostnames"

   VITE_DEFAULT_EVENT_SLUG="$confpilot_event_slug" \
   VITE_SOURCE_URL="$confpilot_source_url" \
   pnpm build

   pnpm --dir apps/api deploy:verify-artifact \
     --config "$confpilot_wrangler_config" \
     --source-url "$confpilot_source_url" \
     --event-slug "$confpilot_event_slug" \
     --hostnames "$confpilot_hostnames"
   ```

   The preflight is a local config-to-input comparison. The explicit build binds that same value as `VITE_SOURCE_URL`, and `deploy:verify-artifact` proves the resulting web artifact contains it, performs a Wrangler dry run with the exact ignored config, and starts that config locally against an isolated migrated D1 database to prove `/llms.txt` is Worker-generated `text/plain` rather than the SPA shell. None of these commands changes remote state. Separately verify by name that the Turnstile secret exists, and inspect the bound R2 bucket to confirm that it has neither an `r2.dev` URL nor a public custom domain.
10. From `apps/api`, use `pnpm exec wrangler deploy --config wrangler.preview.local.jsonc` to deploy the just-built `apps/web/dist` to the stable `workers.dev` hostname; do not rebuild with different environment values between steps 9 and 10. That exact hostname must already be configured in both the Turnstile widget and `TURNSTILE_ALLOWED_HOSTNAMES` and included in the preflight; do not use a per-version preview URL for the registration test.
11. Only after preview acceptance, obtain approval to attach both the apex and `www` custom-domain routes and perform the DNS cutover. Confirm that both routes serve this newly deployed Worker before continuing; neither may still resolve to an older Worker or an asset-only deployment. Both hostnames must already be present in the Turnstile widget, `TURNSTILE_ALLOWED_HOSTNAMES`, and the step 9 preflight input.
12. Run `deploy:verify-live --source-url "$confpilot_source_url" --origins "https://cfp.example.org,https://www.cfp.example.org"` from `apps/api`, replacing the example origins. It checks each provisioned origin independently without following redirects and requires the exact source URL in a Worker-generated `/llms.txt` body whose media type is exactly `text/plain`; status-only checks do not certify the deployment.

Set `CALENDAR_UID_DOMAIN` in every ignored production environment configuration before the first deployment. Choose one stable normalized domain for calendar event identities; it may be a UID-only domain and does not need to serve ConfPilot. The runtime request-host fallback is defensive behavior for development and unsafe input, not a production configuration path, and the deploy preflight rejects a missing or invalid value. Changing this value after attendees subscribe may cause calendar clients to treat existing sessions as different events.

If Turnstile variables or the secret are incomplete, the public CFP explicitly disables account creation and the registration API fails closed. The public site key is not a secret; the secret key must never reach the browser, logs, repository, or screenshots.

## Preview smoke-test matrix

Use synthetic identities and reserved example-domain addresses.

- anonymous program and enabled embeds load without authentication;
- hidden, unapproved, unscheduled, or unpublished records do not appear publicly;
- public registration cannot submit before Turnstile succeeds;
- a valid registration creates one user, one event membership, one speaker, and one hardened session;
- organizer, reviewer, and speaker routes reject the wrong role and wrong event;
- decision recording does not send or queue a notification automatically;
- acceptance is idempotent and materializes one connected session;
- speaker profile, task, headshot, and presentation workflows persist after reload;
- agenda placement rejects room overlaps and surfaces manual speaker overlaps as diagnostics; unresolved speaker conflicts block publication, auto-placement avoids both conflict types, and publication updates the program and embed after reload once conflicts are clear;
- 390 px, 768 px, and 1280 px layouts have no document overflow and retain keyboard-visible focus; at 390 px the public program's `Source code (AGPL-3.0-or-later)` link remains visible, focusable, and opens the configured Corresponding Source URL.

## DNS and mail preservation

Cloudflare's DNS quick scan is not authoritative. Before changing nameservers, export or capture the current zone and manually compare every record in Cloudflare. Preserve all active mail records, including MX and sender-policy TXT records, as DNS-only entries.

Cutover gate:

1. Record the existing authoritative nameservers and all current records outside the repository.
2. Add and verify the complete record set in Cloudflare.
3. Confirm the apex and `www` target the approved Worker/custom domain configuration.
4. Confirm mail records are present and unproxied.
5. Change nameservers only with explicit approval.
6. Verify public DNS, HTTPS, application health, and mail routing after propagation.

References: [full zone setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) and [DNS quick scan limitations](https://developers.cloudflare.com/dns/zone-setups/reference/dns-quick-scan/).

## Rollback

- Worker regression: compare the candidate Worker version with the exact deployed `0000`-through-`0025` migration ledger before rollback, and use only a version verified against that schema. Do not assume the forward-only migrations are compatible with every older Worker: `0008_workers_password_iterations.sql` permits legacy 600,000-iteration credential rows to remain, but its triggers require newly inserted or materially updated credentials to use 100,000 iterations, so a pre-`0008` credential writer can fail. A Worker version not verified against the rebuilt invitation tables and expiry transition in `0023_reviewer_invitation_expiry_compatibility.sql` plus the forward hardening in `0024_integrated_review_hardening.sql` and release guards in `0025_release_review_guards.sql` must not be approved as a rollback target; use the documented restore or forward-fix path instead. Prefer a forward fix whenever compatibility is unproven; any schema restore requires the separately approved D1 recovery path below.
- Turnstile regression: keep registration fail-closed; restore the prior widget variables or Worker version rather than bypassing validation.
- D1 data regression: inspect a Time Travel bookmark first. Restore only with explicit destructive-action approval.
- R2 regression: stop new writes and roll back application code. Do not bulk-delete objects during incident response.
- DNS regression: restore the previously captured web records or nameservers. Do not remove preserved mail records.

Record the deployed Worker version, migration set, D1 bookmark, smoke-test result, and rollback decision without copying account identifiers, tokens, real user data, or local paths into the repository.
