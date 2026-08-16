# Contributing to ConfPilot

ConfPilot welcomes focused bug reports, tests, documentation improvements, and changes that strengthen the connected conference lifecycle.

ConfPilot is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). Contributions are accepted under those same terms — inbound equals outbound. You keep the copyright in your work and license it to the project and its users under the AGPL.

Sign off each commit to certify you have the right to submit it under the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "your message"
```

Do not submit code or content you are not authorized to contribute, including code an AI assistant produced from sources you have not checked. See [docs/licensing.md](docs/licensing.md) for what the AGPL means for self-hosters and for the project's position on contributor license agreements.

## Before opening a change

- Keep one issue or behavior per change.
- Preserve event and role scoping, idempotent acceptance, public publication gates, private file access, and same-origin request safety.
- Use fictional identities and reserved example domains in fixtures.
- Never include credentials, account IDs, private URLs, personal contact details, real attendee data, local machine paths, generated databases, or `.dev.vars`.
- Do not run remote deployments, migrations, billing changes, or DNS changes as part of a contribution unless a maintainer has explicitly authorized that exact operation.

## Local development

Requirements: Node.js 22.12.0 or newer and pnpm 11.16.0.

```bash
pnpm install
test -e apps/api/.dev.vars || cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm --filter @confpilot/api db:migrate:local
```

Load the demo program, then give yourself an account that can sign in to it. The seed creates users and memberships but deliberately contains **no credentials**, so this second step is what makes the instance usable:

```bash
pnpm --filter @confpilot/api db:seed:local

cat > apps/api/.wrangler/member.json <<'JSON'
{
  "eventSlug": "devflow-conf-2027",
  "role": "organizer",
  "member": {
    "displayName": "Dev Organizer",
    "email": "dev-organizer@community.example",
    "password": "replace-with-a-unique-strong-password"
  }
}
JSON
chmod 600 apps/api/.wrangler/member.json

pnpm --dir apps/api db:prepare-member -- --input .wrangler/member.json --output .wrangler/member.sql
pnpm --filter @confpilot/api exec wrangler d1 execute confpilot-db --local --file=.wrangler/member.sql

pnpm dev
```

The password must be 16–128 characters with upper, lower, numeric, and symbol characters. `role` accepts `organizer` or `reviewer`. Speakers are not provisioned this way: a speaker workspace resolves through a `speakers` row that only CFP registration creates, so sign up through the public CFP instead. Sign in at `http://localhost:8787`.

Do **not** use `db:prepare-bootstrap` for this. That helper installs a brand-new instance and refuses to run unless the database is empty; on a seeded database it fails with `NOT NULL constraint failed: events.status`. Bootstrap is an install operation, `db:prepare-member` is an account operation, and they have deliberately opposite preconditions.

The seed files contain fictional local-development data. Never apply them to a production or shared database. Use documented Turnstile test credentials only in the untracked `.dev.vars` file. Every `.wrangler/*.json` and `.wrangler/*.sql` file here contains credential material, stays under an ignored directory, and must never reach source control, logs, or screenshots.

## Code layout

Start at `apps/api/src/app/feature-manifest.ts`. It lists every lifecycle module, what it owns, and where its routes mount, so it is the fastest way to find the code behind a behaviour.

```text
apps/api/src/
  app/          composition: create-app, feature-manifest, platform routes
  runtime/      ports for external capabilities (private files, captcha, email)
  features/     one directory per lifecycle stage
    cfp/ review/ decisions/ agenda/ publication/ speakers/
  auth.ts auth-routes.ts http.ts request-safety.ts types.ts password.ts
```

Two rules keep this navigable:

- **Features do not import each other.** Shared behaviour belongs in the root-level modules or in `runtime/`. If two features need the same logic, lift it rather than reaching across.
- **External capabilities go through `runtime/`.** Feature code should not touch `env.FILES` or a captcha provider directly. Those ports are the only places a non-Cloudflare host would need an adapter, and keeping them narrow is what keeps that claim honest.

The order of `featureManifest` is behaviour, not presentation: Hono matches routes in registration order and several modules declare overlapping patterns under `/api`. Re-run the API tests after changing it.

## Verification

Run the narrowest relevant test while developing, then run the complete local gate before requesting review:

```bash
confpilot_source_url="https://git.example.org/your-account/confpilot"
pnpm run check
pnpm test
VITE_SOURCE_URL="$confpilot_source_url" pnpm build
```

Replace the example with the canonical public HTTP(S) source URL for your current clone. Do not point a fork or modified build at the upstream repository.

Describe the user-visible change, migration or configuration impact, tests run, and any remaining risk. Changes to authentication, authorization, public data contracts, migrations, storage, deployment, or recovery need explicit security and rollback analysis.

## Security reports

Do not open a public issue containing vulnerability details. Follow `SECURITY.md`.
