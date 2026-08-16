# Backup and restore

Status: operator contract. The repository does not yet provide an automated backup command, retention scheduler, or cross-account restore verifier. Operators must implement and test these controls before production use.

## What must be protected

- D1: events, users, memberships, proposals, reviews, decisions, sessions, readiness state, object metadata, schedules, publication state, embeds, and migration history.
- R2: private headshots and every uploaded presentation version, preserving exact object keys and metadata.
- Configuration inventory: Worker version, non-secret variable names and values, binding names, migration ledger, hostname, Turnstile hostname policy, and rate-limit configuration.
- Secrets: recoverable through a separate secrets-management process. Never write secret values into the repository or backup manifest.

A D1-only backup is incomplete because file metadata without the corresponding R2 objects cannot restore uploads. An R2-only backup lacks authorization and lifecycle state.

For Node/Docker the equivalent pair is the SQLite database and `FILES_DIRECTORY`. They must be captured as one recovery point.

## Backup procedure

1. Record the deployed Worker version and D1 migration ledger.
2. Capture a D1 Time Travel bookmark when the account plan supports it, and export D1 to an operator-controlled encrypted destination outside the live account.
3. Copy every R2 object to an operator-controlled destination while preserving its exact key and metadata. Keep the bucket private during and after the copy.
4. Create a manifest containing the backup time, source resource aliases, object count, total bytes, D1 export checksum, R2 manifest checksum, Worker version, and migration ledger. Exclude account IDs, credentials, attendee details, and secret values.
5. Apply retention and access controls appropriate to the event's privacy policy.
6. Verify checksums and perform a restore drill into separate resources.

Use the repository-pinned Wrangler version for D1 operations and consult its command help before execution. Cloudflare command syntax and service limits can change; do not copy an unverified command from this document into production.

## Restore drill

1. Create a separate empty D1 database and private R2 bucket. Never test restore by overwriting the live instance.
2. Import the D1 backup and restore R2 objects under their original exact keys.
3. Verify the migration ledger, `PRAGMA foreign_key_check`, and `PRAGMA quick_check` before starting the application.
4. Deploy the recorded compatible Worker version against the restored resources.
5. With synthetic or appropriately protected test access, verify login, event-role isolation, speaker ownership, headshot and presentation downloads, agenda publication, public visibility rules, calendar export, and embed output.
6. Compare restored row counts, R2 object count and bytes, and manifest checksums. Investigate every mismatch.
7. Record recovery-point age and restore duration. Keep the drill record outside the public repository if it contains operational identifiers.

## Production recovery

Choose the recovery point only after establishing the incident boundary. Stop writes when necessary, preserve logs without copying private payloads, and determine whether code rollback, D1 Time Travel, D1 import, R2 restoration, or a combination is required.

D1 restore and production cutover overwrite or redirect live state and are destructive operations. Require explicit operator approval, record the chosen recovery point, and retain the replaced resources until verification completes. Never retry a partially failed database import or bulk object operation without first inspecting resulting state.

## Node and Docker

The repository does not yet provide an automated volume-backup command. Before production use, choose an encrypted operator-controlled destination and prove this procedure against a separate volume.

1. Stop the ConfPilot service and confirm no process or one-shot container is using the data volume. Copying a live SQLite file and filesystem objects independently is not a coherent backup.
2. Snapshot the complete persistent volume, including `confpilot.sqlite`, any SQLite `-wal`/`-shm` companions, and every object under `FILES_DIRECTORY`. Preserve ownership, permissions, exact relative paths, sizes, and modification times.
3. Record the image digest or Git revision, `SOURCE_URL`, `PUBLIC_ORIGIN`, migration ledger, file count/bytes, and checksums in a manifest outside the public repository. Do not record secrets or attendee data in the manifest.
4. Restore into a new, never-live volume. Preserve the runtime user's access (the container runs as UID 1000) without making the database or files publicly readable.
5. While the application is stopped, run SQLite `PRAGMA quick_check`, `PRAGMA foreign_key_check`, and compare `d1_migrations` with the recorded ledger. Compare file count, byte total, and checksums with the backup manifest.
6. Start the recorded compatible image against the separate volume. Verify login and role isolation, private upload/download authorization, readiness state, publication, public program, embed output, and exact source offer. Restart once more and confirm the same results persist.

Do not restore over the live named volume. Keep the old and restored volumes separate until the drill passes and an explicitly approved cutover occurs. Code rollback does not reverse a SQLite migration or restore deleted file bytes.
