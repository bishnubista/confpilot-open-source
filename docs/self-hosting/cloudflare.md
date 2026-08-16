# Self-host ConfPilot on Cloudflare

Status: pre-release operator guide. This guide describes the intended first supported deployment target and does not claim that clean-account installation has passed an independent test yet.

## Supported deployment shape

ConfPilot is Cloudflare-first. One Worker serves the built Vite application and the Hono API from the same origin. D1 stores relational data, a private R2 bucket stores uploaded files, native rate-limit bindings protect login endpoints, and Turnstile protects public registration.

This guide covers only Cloudflare. A separate [Node/Docker guide](node.md) covers the supported pre-release single-instance SQLite/filesystem host. Kubernetes replicas, Postgres, S3/MinIO, and cross-origin SPA/API deployments are not supported.

## Operator prerequisites

- Node.js 22.12.0 or newer and pnpm 11.16.0.
- A Cloudflare account where you are authorized to enable paid services and create Workers, D1, R2, rate-limit bindings, Turnstile widgets, secrets, and DNS records.
- Workers Paid. The current credential derivation and D1 session path is not certified for the Workers Free CPU budget.
- A public hostname. Keep the SPA and API on the same origin.
- A tested backup destination separate from the live account.

Cloudflare services are usage-based and may incur charges. Confirm current prices and limits in Cloudflare's official documentation immediately before enabling billing. Configure billing alerts before inviting real users.

## Configuration reference

The tracked `apps/api/wrangler.jsonc` is a generic template. Copy it to an ignored environment-specific file such as `apps/api/wrangler.production.local.jsonc`; never commit generated account IDs, secrets, real attendee data, or private URLs.

| Setting or binding | Required | Purpose |
| --- | --- | --- |
| `DB` | yes | D1 database binding. Replace the all-zero `database_id` only in the ignored environment config. |
| `FILES` | yes | Private R2 bucket for headshots and presentation versions. Do not enable public bucket URLs or custom domains. |
| `LOGIN_SOURCE_RATE_LIMITER` | yes | Source-oriented login throttling. Use a positive namespace ID unique across the account. |
| `LOGIN_ACCOUNT_RATE_LIMITER` | yes | Account-oriented login throttling. Use a different positive namespace ID unique across the account. |
| `TURNSTILE_SITE_KEY` | registration | Public Turnstile key; may be stored as a Worker variable. |
| `TURNSTILE_SECRET_KEY` | registration | Turnstile verification secret; store only with Wrangler secrets or the dashboard secret store. |
| `TURNSTILE_ALLOWED_HOSTNAMES` | registration | Comma-separated exact hostnames allowed by server-side verification. |
| `SOURCE_URL` | yes | Public HTTP(S) URL for this instance's Corresponding Source, exposed through `/llms.txt`. Set it to the operator's fork when running a modified version. |
| `CALENDAR_UID_DOMAIN` | yes | Stable domain used after `@` in calendar event UIDs. Set it before production so preview and custom hostnames cannot emit different identities for the same session. The runtime request-host fallback is for development and unsafe input; production preflight rejects a missing or invalid value. |
| `VITE_DEFAULT_EVENT_SLUG` | no | Build-time fallback for the unscoped `/program`, `/submit`, and reviewer URLs. Set it to the bootstrapped event slug before building. Canonical `/events/<slug>/...` routes do not depend on it. |
| `VITE_SOURCE_URL` | yes | Build-time public HTTP(S) URL for this instance's Corresponding Source, linked from the public program at every breakpoint. Use the same URL as `SOURCE_URL`. |

Turnstile configuration fails closed: incomplete configuration disables public account creation. Existing-user sign-in remains available.

During installation, put `SOURCE_URL` in the ignored Wrangler config's top-level `vars` block and export the identical value as `VITE_SOURCE_URL` for the final build. Production builds fail if `VITE_SOURCE_URL` is missing or is not an absolute HTTP(S) URL. After deployment, verify the public program link and `/llms.txt` both expose that exact URL before inviting users.

## Clean installation flow

1. Clone a tagged release. Install the exact package-manager version declared in `package.json`.
2. Run the local type, test, and build gates before creating remote resources.
3. Copy `apps/api/wrangler.jsonc` to an ignored production config. Choose your Worker, D1, and R2 names; replace the D1 all-zero identifier and both rate-limit placeholders only in that copy. The `deploy:agent-install-config` generator in [agent-install.md](agent-install.md#2-write-an-ignored-environment-config--auto) does this from a small JSON plan instead of hand-editing JSONC, and its output is exactly the same file shape.
4. Create D1 and private R2 resources in your Cloudflare account. Verify Wrangler is authenticated to the intended account before each remote mutation.
5. Configure a hostname-restricted Turnstile widget. Store only its public key and allowed hostnames as ordinary variables; store its secret in the provider secret store.
6. Apply every ordered migration to the empty D1 database using the guarded procedure in `docs/operations/cloudflare-deployment.md`. Generate and certify one artifact at a time, beginning with `0000_initial.sql` and the explicit predecessor `none`; never jump directly to the current final migration.
7. Do **not** apply `apps/api/seed/seed.sql` or `apps/api/seed/agenda.sql`. Those are fictional local-development fixtures, not installation data.
8. Provision the initial owner, organizer membership, first event, and baseline CFP configuration with the bootstrap generator below. Do not improvise credentials with ad hoc SQL.
9. Run the local `deploy:preflight` command documented in `agent-install.md` against the ignored config, exact source URL/event slug, and every deployed application hostname. Then set the same `VITE_DEFAULT_EVENT_SLUG` and `VITE_SOURCE_URL` for the frontend build and deploy the same-origin Worker using that config.
10. Verify health, authentication, event isolation, uploads, publication, calendar export, public program output, and embed output with synthetic data before inviting users.
11. Record the Worker version, migration ledger, D1 recovery bookmark, R2 backup checkpoint, and configuration revision.

No step above authorizes a remote mutation. The operator is responsible for reviewing each command and its billing, data, and DNS impact.

## Prepare the first instance

The bootstrap generator performs no network or database mutation. It accepts exact JSON from a mode-`0600` file and writes an inspectable mode-`0600` SQL artifact. The SQL refuses to bootstrap a database where the instance tables are not empty.

Create `apps/api/.wrangler/bootstrap.json`, keep the directory and file ignored, and restrict its permissions before entering the initial password:

```json
{
  "event": {
    "slug": "community-conf",
    "name": "Community Conf",
    "tagline": "Gather and learn",
    "location": "Online",
    "description": "A community-run conference.",
    "startsOn": "2027-06-10",
    "endsOn": "2027-06-11",
    "cfpOpensAt": "2026-09-01T00:00:00Z",
    "cfpClosesAt": "2027-05-01T23:59:00Z",
    "timeZone": "America/Los_Angeles"
  },
  "owner": {
    "email": "owner@community.example",
    "displayName": "Casey Owner",
    "password": "replace-with-a-unique-strong-password"
  }
}
```

The password must be 16–128 characters and include uppercase, lowercase, number, and symbol characters. Use a normalized lowercase slug and email, canonical UTC CFP timestamps, and a valid IANA time zone.

After applying all migrations to a new empty D1 database, run from the repository root:

```bash
chmod 600 apps/api/.wrangler/bootstrap.json
pnpm --dir apps/api db:prepare-bootstrap -- \
  --input .wrangler/bootstrap.json \
  --output .wrangler/bootstrap.sql
```

Inspect the generated SQL without copying its credential material into logs, chat, source control, or screenshots. Apply it exactly once to the intended empty database using the guarded remote-import process. The artifact creates one published event, one owner with an organizer membership, password credential material, and a published baseline CFP with title, abstract, General-track, and talk-format fields. Delete the plaintext input through your secure local process after you have verified login and stored the credential in your password manager; retain or securely destroy the SQL artifact according to your credential-recovery policy.

## Provision an additional account

Use the offline member generator when an event needs another organizer or reviewer account. It does not connect to a database or network. It reads a mode-`0600` JSON file and creates a new, inspectable mode-`0600` SQL artifact only under an ignored `.wrangler` or `.codex` directory.

This helper is the counterpart to the bootstrap generator, with the opposite precondition. Bootstrap installs an instance and refuses to run unless the database is empty. This one adds an account and refuses to run unless the target event already exists. Use bootstrap once per instance; use this for every account after that.

Create `apps/api/.wrangler/member.json`:

```json
{
  "eventSlug": "community-conf",
  "role": "reviewer",
  "member": {
    "email": "reviewer@community.example",
    "displayName": "Riley Reviewer",
    "password": "replace-with-a-unique-strong-password"
  }
}
```

`role` must be exactly `organizer` or `reviewer`; the helper rejects anything else before writing an artifact rather than letting the database's membership constraint fail later. Speakers are deliberately not provisionable — a speaker workspace resolves through a `speakers` row that only CFP registration creates, so a provisioned speaker would sign in to an empty portal. Have them submit through the public CFP instead. Use a normalized lowercase event slug and email. The password follows the same 16–128 character uppercase, lowercase, number, and symbol policy as the initial owner. From the repository root, run:

```bash
chmod 600 apps/api/.wrangler/member.json
pnpm --dir apps/api db:prepare-member -- \
  --input .wrangler/member.json \
  --output .wrangler/member.sql
```

Inspect the generated SQL and apply it once through the guarded remote-import process. It refuses to begin unless exactly one event has the requested slug, the final required migration is in the D1 migration ledger, and the normalized email and generated identities are absent. It creates one user, a supported password credential, and one membership at the requested role; it does not leave a guard table behind. An email already used by any ConfPilot account is intentionally rejected rather than changing that account's access. Use a different address or manage the existing account through an audited future role-management workflow.

After applying the artifact, verify that the account can sign in, can open the surface its role grants, and cannot open a surface it does not. For a reviewer that means `/events/<slug>/reviewer` succeeds, organizer routes return 403, and the account appears in the organizer's reviewer list. Then remove the plaintext input through your secure local process and retain or securely destroy the SQL artifact according to your credential-recovery policy. Neither file belongs in source control, logs, chat, or screenshots.

## If an artifact applies only partially

D1 runs each statement in its own implicit transaction and rejects `BEGIN TRANSACTION` in an imported file, so a failure part-way through leaves the statements before it committed. Both generators are built to fail on their *first* statement when a precondition is false, which is the common case and leaves nothing behind. A later failure is still possible, and it is recoverable rather than silent.

A leftover guard table proves an apply did not finish, but its **absence proves nothing** — the guard is created near the end, so a failure during the inserts leaves no guard table at all. Check both the guard and the rows themselves:

```bash
wrangler d1 execute <database> --remote --command \
  "SELECT name FROM sqlite_master WHERE name IN ('_confpilot_bootstrap_guard','_confpilot_member_guard')"

# The rows the artifact was meant to create. Replace the email with the one
# from your input file; for a bootstrap, check the event slug too.
wrangler d1 execute <database> --remote --command \
  "SELECT u.id, u.email, c.user_id AS has_credential, m.role, m.event_id
   FROM users u
   LEFT JOIN user_credentials c ON c.user_id = u.id
   LEFT JOIN event_memberships m ON m.user_id = u.id
   WHERE lower(trim(u.email)) = 'the-email@example.org'"
```

A user with no credential row, or a credential with no membership, is a partial apply even when no guard table survives.

If a guard table is present, the apply stopped between the inserts and the final check. Inspect the rows the artifact was meant to create, decide whether to keep or remove them, then drop the guard table. Do not simply re-run the artifact: bootstrap will refuse because the tables are no longer empty, and member provisioning will refuse because the email is now taken. Resolve the partial state first, then generate a fresh artifact.

Before removing anything, create a D1 backup and copy the generated IDs from the inspected SQL artifact. If the incomplete bootstrap should be discarded, delete only its generated CFP fields, CFP configuration, membership, credential, user, and event—in that foreign-key order—then drop `_confpilot_bootstrap_guard` if it exists. If an incomplete member provision should be discarded, delete only its generated membership, credential, and user—in that order—then drop `_confpilot_member_guard` if it exists. Use the generated IDs rather than broad email- or event-based deletes, verify that every targeted row is gone, and generate a fresh artifact instead of replaying the old one. If any generated identity is now referenced by data outside that list, stop and restore or reconcile from the backup rather than forcing the cleanup.

## Acceptance gate

A release is self-hostable only after an unfamiliar operator can complete the flow in a clean Cloudflare account without private instructions or production demo seeds. The operator must also prove an upgrade and a restore into separate resources. Until those checks pass, describe the project as preparing for Cloudflare-first self-hosting rather than installation-ready.

## Related operations

- `docs/operations/cloudflare-deployment.md` — exact migration, deployment, DNS, cost, and rollback controls.
- `docs/upgrading.md` — release and migration procedure.
- `docs/backup-restore.md` — D1 and R2 recovery contract.
- `SECURITY.md` — vulnerability reporting and deployment security boundary.
