# Changelog

Notable changes to ConfPilot. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once tagged releases begin.

Until the first tagged release, `main` is the only supported line and the sections below describe unreleased work.

## [Unreleased]

### Added

- **AGPL-3.0-or-later license**, with `NOTICE`, [docs/licensing.md](docs/licensing.md), and a `scripts/audit-licenses.mjs` gate that fails when a dependency declares an unreviewed or missing license.
- AGPL section 13 source offer surfaced at every public-program breakpoint and in `/llms.txt`, configurable per instance via `VITE_SOURCE_URL` and `SOURCE_URL`.
- Cloudflare-first self-hosting guides: install, upgrade, and backup/restore runbooks.
- `deploy:agent-install-config`, an offline generator and patcher for the ignored per-environment Wrangler config described in the agent-assisted installation runbook (Sections 2-4), so an agent copies resource names and rate-limit IDs from a small JSON plan instead of hand-editing JSONC. Its output is proven to pass `deploy:preflight` unchanged.
- `db:prepare-bootstrap`, an offline generator that installs the first event, organizer, credential, and baseline CFP into an empty database.
- `db:prepare-member`, an offline generator that adds an organizer or reviewer account to an instance that already exists. Speakers register through the CFP so the linked speaker profile is created.
- A single-instance Node/Docker host with SQLite, private filesystem storage, transaction-safe bootstrap/member artifact application, reverse-proxy public-origin validation, and reproducible Node/container smoke gates.
- `/llms.txt`, generated from published event rows, describing the instance and its anonymous data endpoints for AI agents and crawlers.
- `AGENTS.md` and an agent-assisted installation runbook that marks every step requiring human authorization.
- Contributor, security, and conduct policies, issue and pull request templates, and dependency update automation.

### Changed

- The API is organized by lifecycle feature (`features/`) behind a composition root (`app/`), with external capabilities declared as ports (`runtime/`). `app/feature-manifest.ts` is the entry point for navigating the codebase.
- Private file access and captcha verification resolve through runtime ports instead of reaching for Cloudflare bindings at each call site.

### Known limitations

- Clean-account installation, upgrade, and restore have not been completed by an independent operator.
- Email delivery is not wired. Decisions record notification intent in an outbox; nothing sends mail.
- No browser end-to-end conformance suite exists; lifecycle coverage is unit and integration tests plus manual browser evidence.
- No independent security assessment has been performed.
