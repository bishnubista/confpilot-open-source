# Upgrade a self-hosted instance

Status: pre-release runbook. Practice this procedure against a copy of the instance before using it in production.

## Compatibility contract

- Upgrade only between tagged releases once tagged releases exist.
- Never rewrite or remove a migration that has reached a shared environment.
- Treat D1 schema and R2 object keys as durable state.
- Apply database migrations before deploying code that depends on them, unless a release note explicitly documents a different backward-compatible order.
- Do not run demo seeds during an upgrade.

## Procedure

1. Read every release note between the current and target versions. Stop if a required intermediate version, manual data repair, or incompatible configuration change is unresolved.
2. Verify the current Worker version, migration ledger, health response, and configuration. Confirm that the ignored Wrangler config targets the intended account and resources.
3. Create a fresh D1 recovery bookmark or export and a complete R2 backup as described in `docs/backup-restore.md`. Record the checkpoint outside the repository.
4. Restore those backups into separate test resources, deploy the target release against them, and run the lifecycle smoke test. A backup that has not been restored is not a verified recovery point.
5. Run the target release's local type, test, and build gates.
6. Inspect the remote migration ledger and schema before applying each new migration. Follow the guarded D1 procedure in `docs/operations/cloudflare-deployment.md`; never retry a partially failed import blindly.
7. Deploy the target Worker version. Verify `/api/health`, login, cross-event authorization, uploads and downloads, agenda publication, calendar export, public program output, and saved embeds.
8. Record the new Worker version, migration ledger, verification result, and recovery checkpoint.

## Rollback boundary

Application code can usually roll back to the last verified Worker version when migrations are additive and backward compatible. Do not reverse a migration or restore D1 merely because a deployment failed. A D1 restore overwrites live state and requires an explicit incident decision after comparing the migration ledger and schema.

If file handling regresses, stop new writes and roll back application code. Do not bulk-delete R2 objects during rollback. Preserve exact object keys because D1 references them.

## Node and Docker

1. Record the running image digest/Git revision, `SOURCE_URL`, `PUBLIC_ORIGIN`, migration ledger, health result, and current volume identity.
2. Stop the service and capture the complete SQLite/filesystem recovery point in [Backup and restore](backup-restore.md#node-and-docker). Restore it into a separate volume and verify it before proceeding.
3. Build the target image from a tagged release with the same exact public `SOURCE_URL`. Run the repository check, test, web/Worker build, Node smoke, Compose validation, and container smoke gates for that revision.
4. Start the target image against the restored test volume first. Startup applies append-only migrations. Run the full lifecycle smoke and a restart-persistence check; never use demo seeds.
5. Stop the live service, retain the old image and volume, then start the target image against the live volume. Verify the migration ledger, `/llms.txt`, source link, login, role boundaries, private files, publication, and embeds before reopening traffic.
6. Record the new image digest/revision, ledger, verification results, and recovery point.

Rolling application code back is safe only when the prior release is compatible with every migration already applied. Never delete or reverse a migration. If a migration or file write caused damage, stop writes and make an explicit recovery decision from the preserved volume rather than repeatedly restarting images.
