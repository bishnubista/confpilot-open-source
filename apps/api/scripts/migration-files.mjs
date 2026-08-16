/** Migration filenames, in the order they must run. */
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/** Refuse SQL files that cannot be ordered rather than silently skipping them. */
export function migrationNames(entries) {
  const sql = entries.filter((name) => name.toLowerCase().endsWith(".sql"));
  const unusable = sql.filter((name) => !MIGRATION_NAME.test(name));
  if (unusable.length > 0) {
    throw new Error(
      `Migration files must be named NNNN_lower_snake_case.sql; cannot order: ${unusable.sort().join(", ")}`,
    );
  }
  return sql.sort();
}
