# Agent-assisted installation

Status: pre-release. This procedure has not yet been completed end to end by an independent operator in a clean Cloudflare account. Treat it as the intended path, not a certified one.

An AI agent may perform the steps marked **[AUTO]**. Steps marked **[GATE]** change billing, public state, remote data, or DNS and require the account owner's explicit approval for that specific operation. An agent must stop at each gate, state exactly what the command will do, and wait. "The user asked me to install ConfPilot" is authorization for the procedure, not for any individual gate.

## 0. Collect before starting

Ask the operator for all of these first, so the run does not stall midway:

| Input | Why | Example |
| --- | --- | --- |
| Git checkout and Git executable | Guarded helpers verify that provider configs and generated SQL are ignored before reading or writing them; source archives are not supported | — |
| Cloudflare account | Owns every resource and the bill | — |
| Public hostname | SPA and API must share one origin | `cfp.example.org` |
| Calendar UID domain | Stable suffix for calendar event IDs; may be UID-only and need not serve the app | `calendar.example.org` |
| Worker / D1 / R2 names | Resource identity | `confpilot`, `confpilot-db`, `confpilot-files` |
| Two rate-limit namespace IDs | Must be positive, distinct, unused account-wide | `2001`, `2002` |
| First event details | Bootstrap input | slug, name, dates, IANA time zone |
| Owner account | First organizer | email, display name, strong password |

The owner password must be 16–128 characters with upper, lower, numeric, and symbol characters. **An agent must never generate, store, log, echo, or transmit this password.** Have the operator enter it directly into the input file and keep it in their password manager.

## 1. Prepare the checkout — [AUTO]

```bash
test "$(git rev-parse --is-inside-work-tree)" = true
pnpm install
pnpm run check && pnpm test
```

The Git check and both package gates must pass before creating any remote resource. The production build runs after the event slug is known in Section 8. Report actual counts; do not proceed on a failing gate. If Git is unavailable or this is not a Git checkout, stop and obtain a proper checkout; do not bypass the helpers' ignore checks.

## 2. Write an ignored environment config — [AUTO]

Recommended: collect the Section 0 inputs into an ignored, mode-0600 install plan and let the generator write the config, instead of hand-editing JSONC. It performs no network or database mutation. Create `apps/api/.wrangler/install-plan.json`:

```json
{
  "workerName": "confpilot",
  "d1Name": "confpilot-db",
  "r2Name": "confpilot-files",
  "rateLimitSourceId": "2001",
  "rateLimitAccountId": "2002",
  "calendarUidDomain": "calendar.example.org",
  "sourceUrl": "https://git.example.org/operator/confpilot"
}
```

```bash
chmod 600 apps/api/.wrangler/install-plan.json
pnpm --dir apps/api deploy:agent-install-config -- init \
  --plan .wrangler/install-plan.json --output wrangler.production.local.jsonc
```

This copies the tracked template's fixed structural fields, writes the Worker/D1/R2 names and both rate-limit IDs, and leaves the D1 `database_id` as the tracked placeholder until Section 3 supplies the real one. It refuses to overwrite an existing file — delete the copy yourself to regenerate it — and it is not a substitute for the `deploy:preflight` gate in Section 8, which independently certifies the result.

Equivalently, copy `apps/api/wrangler.jsonc` to the same ignored filename and hand-edit the same fields: the top-level `name`, `r2_buckets[0].bucket_name`, and the `1001`/`1002` rate-limit placeholders. Never edit the tracked template with real values and never commit the copy either way.

## 3. Create Cloudflare resources — [GATE]

Creating D1, R2, and a Worker, and enabling Workers Paid, are remote account mutations. Present each operation and its cost implications separately, then wait for approval for that specific operation. Workers Paid is required for this credential-authenticated preview; no hosted benchmark currently certifies the application on Workers Free.

As of 2026-08-12, Workers Standard has a $5 USD monthly minimum that includes 10 million dynamic requests and 30 million CPU milliseconds; additional requests and CPU, plus D1 and R2 usage above their included allowances, are billed separately. Pricing can change, so verify the [current official pricing](https://developers.cloudflare.com/workers/platform/pricing/) and configure billing alerts before approval. Enabling Workers Paid is a dashboard-only account change: **[GATE]** the operator must approve and complete it in Cloudflare's Workers & Pages subscription settings.

Before every remote command, run `pnpm --dir apps/api exec wrangler whoami` and have the operator verify the intended account. If Section 2 used the install plan, `pnpm --dir apps/api deploy:agent-install-config -- resource-commands --plan .wrangler/install-plan.json` prints these same two commands with the plan's real resource names already substituted, so nothing is retyped from prose. Either way, request a separate approval before each command below; placeholders are shell variables, not values to paste unchanged:

```bash
confpilot_database="replace-with-d1-name"
pnpm --dir apps/api exec wrangler d1 create "$confpilot_database"
```

Copy the returned D1 ID into `d1_databases[0].database_id` in the ignored config, or run `pnpm --dir apps/api deploy:agent-install-config -- set-d1-id --config wrangler.production.local.jsonc --id <returned-id>` if Section 2 used the generator. Keep the `DB` binding name unchanged.

```bash
confpilot_bucket="replace-with-r2-name"
pnpm --dir apps/api exec wrangler r2 bucket create "$confpilot_bucket" --storage-class Standard
```

The R2 name must match `r2_buckets[0].bucket_name` in the ignored config; keep the `FILES` binding name unchanged. The Worker itself is created by the first approved deploy in Section 8, using the top-level `name` from that same config.

## 4. Configure Turnstile — [GATE]

Create a hostname-restricted widget. If Section 2 used the generator, add the full vars block in one step — it reads `CALENDAR_UID_DOMAIN` and `SOURCE_URL` back from the same install plan, so only the two values this gate actually produces need to be typed:

```bash
pnpm --dir apps/api deploy:agent-install-config -- set-vars \
  --config wrangler.production.local.jsonc --plan .wrangler/install-plan.json \
  --turnstile-site-key "replace-with-public-site-key" \
  --allowed-hostnames "confpilot.example.org,confpilot.example.workers.dev"
```

Otherwise, add these top-level ordinary variables by hand (alongside `assets`, not inside it):

```jsonc
"vars": {
  "TURNSTILE_SITE_KEY": "replace-with-public-site-key",
  "TURNSTILE_ALLOWED_HOSTNAMES": "confpilot.example.org,confpilot.example.workers.dev",
  "CALENDAR_UID_DOMAIN": "calendar.example.org",
  "SOURCE_URL": "https://git.example.org/operator/confpilot"
}
```

`TURNSTILE_ALLOWED_HOSTNAMES` is a comma-separated list that must exactly match the deployed hostnames, without schemes, paths, ports, or wildcards. Cloudflare's [published Turnstile test sitekeys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/#test-sitekeys) are for development and automated testing only; the production preflight rejects all of them. Choose `CALENDAR_UID_DOMAIN` once and keep it stable. It may be a normalized UID-only domain that does not serve ConfPilot and does not appear in `TURNSTILE_ALLOWED_HOSTNAMES`.

Store `TURNSTILE_SECRET_KEY` only with the dashboard secret store or, after a separate approval, the interactive command below. The operator enters the secret at Wrangler's prompt; an agent must never supply, expose, read back, or record its value.

```bash
pnpm --dir apps/api exec wrangler secret put TURNSTILE_SECRET_KEY \
  --config wrangler.production.local.jsonc
```

Turnstile fails closed: incomplete configuration disables public registration but leaves existing-user sign-in working.

## 5. Apply migrations to the empty database — [GATE]

Follow the guarded procedure in [cloudflare-deployment.md](../operations/cloudflare-deployment.md). Inspect the remote migration ledger before and after. Never blindly retry a partially failed import.

For a new empty database, generate and apply one artifact at a time starting with `0000_initial.sql --predecessor none`, certify that step, and only then advance to the next exact target and predecessor. Do not generate only the final catalog migration.

Do **not** apply `apps/api/seed/seed.sql` or `seed/agenda.sql`. Those are fictional local fixtures, not installation data.

## 6. Generate the bootstrap artifact — [AUTO]

Safe by construction: no network, no database write, output is an inspectable `0600` SQL file under an ignored directory.

Create the ignored directory if needed. The operator must then create `apps/api/.wrangler/bootstrap.json` and enter the event and owner values, including the password, as specified in [cloudflare.md](cloudflare.md). Only after the file exists should the agent restrict its permissions and run the generator:

```bash
mkdir -p apps/api/.wrangler
chmod 600 apps/api/.wrangler/bootstrap.json
pnpm --dir apps/api db:prepare-bootstrap -- \
  --input .wrangler/bootstrap.json --output .wrangler/bootstrap.sql
```

The operator writes `bootstrap.json` themselves because it contains the owner password. The agent must not open, echo, log, or transmit it.

## 7. Apply the bootstrap artifact — [GATE]

Applying it writes the owner identity and credential. Its first `events` insert checks that the required migration appears exactly once in `d1_migrations` and that all six instance tables — `events`, `users`, `user_credentials`, `event_memberships`, `cfp_configs`, and `cfp_fields` — are empty. If any check fails, D1 reports `NOT NULL constraint failed: events.status`. Apply exactly once.

That message does not distinguish a missing migration from non-empty or partially applied data. Inspect the migration ledger and all six tables before doing anything else. Follow “If an artifact applies only partially” in [cloudflare.md](cloudflare.md), including its backup and exact-ID cleanup rules, before generating a fresh artifact and retrying. Do not use `db:prepare-member` as a generic recovery path.

## 8. Build and deploy — [GATE]

Set `VITE_DEFAULT_EVENT_SLUG` to the bootstrapped slug and `VITE_SOURCE_URL` to the same public Corresponding Source URL used for `SOURCE_URL`. Run the final production build only after both values are present; `apps/web/dist` produced by this command is the exact static artifact the Worker deploys.

```bash
confpilot_event_slug="replace-with-bootstrapped-slug"
confpilot_source_url="https://git.example.org/operator/confpilot"
confpilot_wrangler_config="wrangler.production.local.jsonc"
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

The preflight reads the ignored config locally and prints no provider identifiers. It fails unless `/api`, `/api/*`, and `/llms.txt` run through the Worker; the source offer matches the frontend build; calendar identity and deployed hostnames are exact; the Turnstile site key is production-only; the Turnstile hostname allowlist exactly matches the deployed hostnames; and D1, R2, and both reviewed login rate-limit bindings are present with non-placeholder identities. `CALENDAR_UID_DOMAIN` is checked separately because it may be a stable UID-only domain rather than an application hostname. The artifact verification then uses that same ignored config and the already-built web assets for a Wrangler dry run and isolated local runtime check. It fails if the web artifact has a different source offer or `/llms.txt` resolves to the SPA shell instead of Worker-generated `text/plain`. Both commands are local and neither changes a remote resource. These checks do not prove that the R2 bucket is private or that the Turnstile secret exists; certify those read-only remote conditions immediately before the approved deploy.

After the build passes, request approval for the public Worker mutation and deploy with the ignored config. This first deploy creates the Worker named by the config's top-level `name`; later runs update it.

```bash
pnpm --dir apps/api exec wrangler deploy \
  --config wrangler.production.local.jsonc
```

Before continuing to live verification, obtain approval to provision or update both the apex and `www` custom-domain routes so they serve this newly deployed Worker. Confirm that neither origin still resolves to an older Worker or an asset-only deployment. Both hostnames must already be present in the Turnstile widget, `TURNSTILE_ALLOWED_HOSTNAMES`, and the preflight input above.

## 9. Verify — [AUTO]

Read-only checks an agent should run and report verbatim. Replace `$BASE` and `$SLUG`.

Before the wider matrix, verify both the apex and `www` response bodies without following redirects. A `200` alone is insufficient because an asset-only deployment can serve the SPA shell at `/llms.txt`:

```bash
confpilot_origins="https://cfp.example.org,https://www.cfp.example.org"

pnpm --dir apps/api deploy:verify-live \
  --source-url "$confpilot_source_url" \
  --origins "$confpilot_origins"
```

This gate requires each origin's `/llms.txt` to return `200` with a media type exactly equal to `text/plain`, begin with the Worker-generated ConfPilot document, contain the exact Corresponding Source URL, and contain no SPA-shell markup.

| Check | Expected |
| --- | --- |
| `GET $BASE/api/health` | `200`, `"database":"connected"` |
| `GET $BASE/` | `200` (SPA shell) |
| `GET $BASE/api/events` | `200`, lists the published event |
| `GET $BASE/api/program?event=$SLUG` | `200` |
| `GET $BASE/api/cfp/$SLUG` | `200`, `"status":"published"` |
| `GET $BASE/api/program.ics?event=$SLUG` | `200` |
| Same-origin `POST $BASE/api/program.ics` with JSON `{ "event": "$SLUG", "sessionSlugs": ["<public-session-slug>"] }` and `X-ConfPilot-Request: 1` | `200`, `Cache-Control: private, no-store`; the selected slug is absent from the request URL |
| `GET $BASE/api/events/$SLUG/readiness` **without** a session | `401` |
| `GET $BASE/llms.txt` | `200`, lists the event and its data endpoints |
| Public program in a browser at a 390 px viewport | The `Source code (AGPL-3.0-or-later)` link is visible, keyboard-focusable, and opens the configured Corresponding Source URL. |

Owner sign-in must be performed by the operator, not the agent, because it requires the password. Inspect the raw `Set-Cookie` response header, not the browser's stored-cookie view. A successful sign-in returns `200` with a cookie named `__Host-confpilot_session` that includes `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`, includes no `Domain` attribute, and returns a membership of `organizer`.

If the `401` check returns anything else, stop and report it as an authorization failure. Do not continue to invite users.

## 10. Record and hand off — [AUTO]

Record the Worker version, migration ledger state, D1 recovery bookmark, R2 backup checkpoint, and config revision. Then tell the operator, in plain terms:

- Which gates they approved and what each one changed.
- That `bootstrap.json` and `bootstrap.sql` still contain credential material and should be destroyed or secured per their policy.
- That backups are unverified until restored into separate resources — see [backup-restore.md](../backup-restore.md).
- That no independent security assessment has been done, per [SECURITY.md](../../SECURITY.md).

## Failure modes worth naming

| Symptom | Cause |
| --- | --- |
| `NOT NULL constraint failed: events.status` when bootstrapping | The required migration ledger check or one of the six empty-table checks failed. Inspect `d1_migrations` and all six instance tables, then follow the documented partial-apply cleanup before retrying. |
| Public registration returns `503 REGISTRATION_UNAVAILABLE` | Turnstile is unconfigured or hostname-mismatched. Sign-in still works. |
| Login succeeds locally but fails on Workers Free | Workers Free is unsupported for this credential-authenticated preview. Reproduce on the required Workers Paid plan and report the raw response and Worker logs; no hosted Free-plan benchmark currently supports a narrower diagnosis. |
| Rate limiting behaves across unrelated Workers | A namespace ID is reused. IDs must be unique account-wide. |
