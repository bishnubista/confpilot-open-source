import { execFileSync } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION_FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LEDGER_TABLE = "d1_migrations";
const NO_PREDECESSOR = "none";
const GUARD_TABLE = "_confpilot_remote_migration_guard";

function migrationNumber(filename) {
  const match = MIGRATION_FILENAME.exec(filename);
  if (!match) throw new Error(`Invalid migration filename: ${filename}`);
  return Number(match[1]);
}

function validateBareFilename(value, label) {
  if (typeof value !== "string" || !MIGRATION_FILENAME.test(value) || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be an exact migration filename, not a path.`);
  }
}

function validatePredecessor(value) {
  if (value === NO_PREDECESSOR) return;
  validateBareFilename(value, "Predecessor");
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function ledgerInitializationSql() {
  return `CREATE TABLE IF NOT EXISTS "${LEDGER_TABLE}" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT UNIQUE,
  "applied_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
}

function ledgerGuardSql(expectedMigrations) {
  const expectedOrder = sqlLiteral(expectedMigrations.join("\n"));
  const expectedCount = expectedMigrations.length;
  const expectedSchema = sqlLiteral([
    "0|id|INTEGER|0||1",
    "1|name|TEXT|0||0",
    "2|applied_at|TIMESTAMP|1|CURRENT_TIMESTAMP|0",
  ].join("\n"));
  const expectedTableSql = sqlLiteral(
    "createtabled1_migrations(idintegerprimarykeyautoincrement,nametextunique,applied_attimestampdefaultcurrent_timestampnotnull)",
  );
  return `CREATE TABLE "${GUARD_TABLE}" (
  "ok" INTEGER NOT NULL CHECK ("ok" = 1)
);

INSERT INTO "${GUARD_TABLE}" ("ok")
SELECT CASE WHEN (
  SELECT count(*)
  FROM "${LEDGER_TABLE}"
) = ${expectedCount}
AND (
  SELECT count("name")
  FROM "${LEDGER_TABLE}"
) = ${expectedCount}
AND (
  SELECT COALESCE(group_concat("name", char(10)), '')
  FROM (SELECT "name" FROM "${LEDGER_TABLE}" ORDER BY "id")
) = ${expectedOrder}
AND (
  SELECT COALESCE(group_concat("signature", char(10)), '')
  FROM (
    SELECT printf(
      '%d|%s|%s|%d|%s|%d',
      "cid", "name", upper("type"), "notnull", COALESCE("dflt_value", ''), "pk"
    ) AS "signature"
    FROM pragma_table_info('${LEDGER_TABLE}')
    ORDER BY "cid"
  )
) = ${expectedSchema}
AND (
  SELECT lower(replace(replace(replace(replace(replace("sql", char(10), ''), char(13), ''), char(9), ''), ' ', ''), '"', ''))
  FROM sqlite_master
  WHERE "type" = 'table'
    AND "name" = '${LEDGER_TABLE}'
) = ${expectedTableSql}
AND EXISTS (
  SELECT 1
  FROM pragma_index_list('${LEDGER_TABLE}')
  WHERE "name" = 'sqlite_autoindex_${LEDGER_TABLE}_1' AND "unique" = 1
)
AND (
  SELECT COALESCE(group_concat("name", char(10)), '')
  FROM (SELECT "name" FROM pragma_index_info('sqlite_autoindex_${LEDGER_TABLE}_1') ORDER BY "seqno")
) = 'name'
THEN 1 ELSE 0 END;

DROP TABLE "${GUARD_TABLE}";`;
}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function outputPath(apiRoot, value, migration) {
  const repoRoot = resolve(apiRoot, "../..");
  const relativeOutput = value ?? `.wrangler/remote-migrations/${migration}`;
  if (isAbsolute(relativeOutput)) {
    throw new Error("Output must be a relative path under an ignored .wrangler or .codex directory.");
  }
  const resolvedOutput = resolve(apiRoot, relativeOutput);
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  if (!allowedRoots.some((root) => isWithin(resolvedOutput, root))) {
    throw new Error("Output must remain under an ignored .wrangler or .codex directory.");
  }
  return resolvedOutput;
}

async function ensureDirectoryWithoutSymlink(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Output directory must not escape through a symbolic link.");
  }
}

async function prepareOutputDirectory(apiRoot, destination) {
  const repoRoot = resolve(apiRoot, "../..");
  const allowedRoots = [resolve(apiRoot, ".wrangler"), resolve(repoRoot, ".codex")];
  const allowedRoot = allowedRoots.find((root) => isWithin(destination, root));
  if (!allowedRoot) throw new Error("Output path is outside the approved ignored directories.");

  await ensureDirectoryWithoutSymlink(allowedRoot);
  const realRoot = await realpath(allowedRoot);
  let currentDirectory = allowedRoot;
  const parentSegments = relative(allowedRoot, dirname(destination)).split(sep).filter(Boolean);
  for (const segment of parentSegments) {
    currentDirectory = resolve(currentDirectory, segment);
    await ensureDirectoryWithoutSymlink(currentDirectory);
    const realDirectory = await realpath(currentDirectory);
    if (!isWithin(realDirectory, realRoot)) {
      throw new Error("Output directory must not escape through a symbolic link.");
    }
  }
  try {
    const insideWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: apiRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (insideWorkTree !== "true") throw new Error("not a work tree");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Git is required to verify that the migration artifact output is ignored.");
    }
    throw new Error("Migration artifacts must be prepared from a Git checkout so ignore coverage can be verified.");
  }
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", relative(apiRoot, destination)], {
      cwd: apiRoot,
      stdio: "ignore",
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Git is required to verify that the migration artifact output is ignored.");
    }
    if (error?.status !== 1) {
      throw new Error("Git could not verify migration artifact ignore coverage; refusing to write the artifact.");
    }
    throw new Error("Output must be ignored by Git before a migration artifact is written.");
  }
}

export async function prepareRemoteMigration({
  apiRoot,
  migration,
  predecessor,
  output,
}) {
  validateBareFilename(migration, "Migration");
  validatePredecessor(predecessor);

  const migrationsRoot = resolve(apiRoot, "migrations");
  const migrations = (await readdir(migrationsRoot))
    .filter((filename) => MIGRATION_FILENAME.test(filename))
    .sort();
  if (migrations.length === 0) throw new Error("No migrations were found.");

  for (const [index, filename] of migrations.entries()) {
    if (migrationNumber(filename) !== index) {
      throw new Error(`Migration sequence is not contiguous at ${filename}.`);
    }
  }

  const targetIndex = migrations.indexOf(migration);
  if (targetIndex < 0) throw new Error("The target migration does not exist.");
  const actualPredecessor = targetIndex === 0 ? NO_PREDECESSOR : migrations[targetIndex - 1];
  if (predecessor !== actualPredecessor) {
    throw new Error(`Predecessor mismatch: expected ${actualPredecessor}.`);
  }

  const migrationSql = await readFile(resolve(migrationsRoot, migration), "utf8");
  if (/\bd1_migrations\b/i.test(migrationSql)) {
    throw new Error("Migration SQL must not modify the Wrangler migration ledger directly.");
  }
  const ledgerInsert = `INSERT INTO "${LEDGER_TABLE}" ("name")\nVALUES (${sqlLiteral(migration)});`;
  const sections = [];
  if (targetIndex === 0) sections.push(ledgerInitializationSql());
  sections.push(
    ledgerGuardSql(migrations.slice(0, targetIndex)),
    migrationSql,
    ledgerInsert,
  );
  const artifact = sections.join("\n\n");
  const destination = outputPath(apiRoot, output, migration);

  await prepareOutputDirectory(apiRoot, destination);
  await writeFile(destination, artifact, { encoding: "utf8", flag: "wx", mode: 0o600 });

  return {
    artifact,
    migration,
    predecessor,
    output: relative(apiRoot, destination),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (index === 0 && flag === "--") continue;
    if (!["--migration", "--predecessor", "--output"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.migration || !options.predecessor) {
    throw new Error("Usage: prepare-remote-migration --migration <file> --predecessor <file|none> [--output <ignored-relative-path>]");
  }
  return options;
}

export async function runRemoteMigrationCli({ apiRoot, argv, log = console.log }) {
  const result = await prepareRemoteMigration({ apiRoot, ...parseArguments(argv) });
  log(`Prepared ${result.migration} after ${result.predecessor}.`);
  log(`Artifact: ${result.output}`);
  log("No database command was executed. Verify the remote ledger and capture a Time Travel bookmark before applying this file once.");
}

async function main() {
  const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runRemoteMigrationCli({ apiRoot, argv: process.argv.slice(2) });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
