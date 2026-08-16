# Self-host ConfPilot with Node or Docker

Status: pre-release operator guide. The Node bundle and container are built and smoked in CI, but a clean install, backup/restore drill, and full browser lifecycle have not yet been completed by an independent operator.

## Supported shape and limits

This target runs the same Hono application as the Cloudflare Worker with SQLite and a private filesystem directory. It is a **single-instance** deployment: do not run multiple containers against one local volume or network filesystem. Put a TLS-terminating reverse proxy in front, keep the SPA and API on one public origin, and do not serve the private data volume from that proxy.

The Node host has no email transport. Messages remain queued in the outbox. Turnstile fails closed: without a complete site key, secret, and hostname allowlist, public registration returns `503`; existing accounts can still sign in.

## Configure one exact image

From a Git checkout, copy the Compose example and edit both public values:

```bash
cp .env.example .env
```

- `PUBLIC_ORIGIN` is the exact browser-visible HTTPS origin, normally `https://confpilot.example.org`. Cleartext is accepted only for loopback development. This is not the proxy-to-container HTTP URL, and the host does not trust forwarded scheme or host headers.
- `SOURCE_URL` is the public Corresponding Source for the exact version being built. Compose uses this one value for the SPA footer and the runtime `/llms.txt` response; startup rejects a runtime override that differs from the built artifact.

Build and start on loopback:

```bash
docker compose build
docker compose up -d
```

The first start creates the SQLite database and applies every ordered migration. It does **not** create credentials or an event. Keep `127.0.0.1:8787` private and route the public HTTPS origin to it through a proxy that overwrites, rather than appends to, any trusted client-IP header.

## Bootstrap the first organizer

Create the mode-`0600` bootstrap input exactly as described in [the Cloudflare guide](cloudflare.md#prepare-the-first-instance), then generate the offline SQL artifact:

```bash
pnpm --dir apps/api db:prepare-bootstrap -- \
  --input .wrangler/bootstrap.json \
  --output .wrangler/bootstrap.sql
```

Stop the server so the one-shot command is the only database writer. Mount the credential-bearing artifact read-only and apply it in one SQLite transaction:

```bash
docker compose stop confpilot
docker compose run --rm --no-deps \
  --volume "$PWD/apps/api/.wrangler/bootstrap.sql:/run/confpilot/bootstrap.sql:ro" \
  confpilot node apply-sqlite-artifact.mjs \
  --database /var/lib/confpilot/confpilot.sqlite \
  --input /run/confpilot/bootstrap.sql
docker compose up -d
```

The applicator refuses a missing or incompletely migrated database, symlinked artifact, or artifact readable by group/other; it rolls every statement back if any statement or foreign-key check fails. It performs no network operation. Protect or destroy the plaintext JSON and generated SQL according to your credential-recovery policy.

For later organizers or reviewers, generate `member.sql` with `db:prepare-member`, stop the service, and apply it with the same one-shot command. Speakers must register through the CFP so their account is linked to the event speaker profile.

## Run the bundle without Docker

Build both artifacts with the same source offer, copy `apps/api/.env.example` to `apps/api/.env`, replace the container paths with local absolute paths, then start from `apps/api`:

```bash
VITE_SOURCE_URL="$SOURCE_URL" pnpm --filter @confpilot/web build
pnpm --filter @confpilot/api build:node
pnpm --filter @confpilot/api start:node
```

`start:node` loads `apps/api/.env` when it exists; exported environment variables take precedence. Apply bootstrap/member SQL with `db:apply-sqlite-artifact` only while the server is stopped.

## Verification before real use

Verify all of the following after first start and after every upgrade:

1. `/llms.txt` and the public-program source link expose the same exact `SOURCE_URL`.
2. A same-origin mutation succeeds through the HTTPS proxy, while a mismatched `Origin` returns `403 UNSAFE_REQUEST_REJECTED` even when forwarded headers claim HTTPS.
3. Organizer login works; public registration either completes through Turnstile or visibly fails closed.
4. Private uploads cannot be fetched by a static URL or another role/event.
5. A fresh, non-seed proposal reaches review, acceptance, speaker readiness/upload, scheduling, publication, the public program, and a saved embed; restart the container and confirm the same database and file state remains.

Use [Backup and restore](../backup-restore.md#node-and-docker) and [Upgrading](../upgrading.md#node-and-docker) before treating the instance as production-ready.
