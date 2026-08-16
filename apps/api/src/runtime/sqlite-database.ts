/**
 * A `Database` implementation over a local SQLite file.
 *
 * This is the adapter that lets the API run somewhere other than Cloudflare.
 * It is written against `better-sqlite3` rather than `node:sqlite` because the
 * latter is still release-candidate, and because the batch semantics below need
 * a real immediate transaction.
 *
 * **This module must never be imported from the Worker entry.** It pulls in a
 * native module that cannot be bundled for workerd, so it is deliberately absent
 * from `runtime/index.ts`; a Node entry point imports it directly instead.
 *
 * Every behaviour here was matched against real D1 under Miniflare, and
 * `test/database-conformance.test.mjs` runs the same suite against both. The
 * non-obvious ones, each of which a naive implementation gets wrong:
 *
 * - `run()` on a SELECT returns its rows. It is not a write-only call; D1 makes
 *   it equivalent to `all()`. Returning an empty array here is the single
 *   easiest way to break a caller that reads rows back out of a batch.
 * - `batch()` returns one result per statement *with rows populated*, and is
 *   atomic: a failure anywhere rolls the whole batch back.
 * - `first(column)` throws when the column is absent, rather than returning
 *   undefined, matching D1's `D1_COLUMN_NOTFOUND`.
 * - A statement may bind at most `MAX_BOUND_PARAMETERS`; exceeding it is an
 *   error here exactly as it is on D1, so a query that would fail in production
 *   also fails locally instead of silently working.
 */
import type { Database, DatabaseMeta, DatabaseResult, DatabaseStatement } from "./database";
import { MAX_BOUND_PARAMETERS } from "./database";

/** The subset of `better-sqlite3` this adapter uses, so the dependency stays untyped here. */
interface SqliteDriverStatement {
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  reader: boolean;
}

export interface SqliteDriver {
  prepare(sql: string): SqliteDriverStatement;
  exec(sql: string): unknown;
}

function meta(changes: number, lastRowId: number): DatabaseMeta {
  return {
    changes,
    duration: 0,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    rows_read: 0,
    rows_written: changes,
    served_by: "sqlite",
    size_after: 0,
  };
}

class SqliteStatement implements DatabaseStatement {
  readonly #statement: SqliteDriverStatement;
  readonly #parameters: readonly unknown[];

  constructor(statement: SqliteDriverStatement, parameters: readonly unknown[] = []) {
    this.#statement = statement;
    this.#parameters = parameters;
  }

  bind(...values: unknown[]): DatabaseStatement {
    return new SqliteStatement(this.#statement, values);
  }

  /**
   * Execute and collect rows, synchronously.
   *
   * `better-sqlite3` refuses `all()` on a statement that returns no data, so the
   * driver's own `reader` flag decides which call to make. Both paths produce the
   * same result shape, which is what keeps `run()` and `all()` interchangeable
   * for reads the way D1 has them.
   *
   * Deliberately not part of `DatabaseStatement`, and deliberately not async:
   * `batch()` calls it so statements run with no `await` between them. The driver
   * is synchronous, so awaiting would buy nothing and introduce a yield point
   * inside an open transaction where another caller could interleave its own
   * `BEGIN IMMEDIATE`.
   */
  execute<Row>(): DatabaseResult<Row> {
    // Enforced here rather than in `bind()` so the failure surfaces when the
    // statement executes, which is when D1 raises it. Matching the message but
    // not the timing would let a caller's try/catch behave differently per host.
    if (this.#parameters.length > MAX_BOUND_PARAMETERS) {
      throw new Error(`too many SQL variables: ${this.#parameters.length} exceeds the ${MAX_BOUND_PARAMETERS} supported per statement`);
    }
    if (this.#statement.reader) {
      const rows = this.#statement.all(...this.#parameters) as Row[];
      return { success: true, results: rows, meta: meta(0, 0) };
    }
    const outcome = this.#statement.run(...this.#parameters);
    return {
      success: true,
      results: [],
      meta: meta(Number(outcome.changes), Number(outcome.lastInsertRowid)),
    };
  }

  async first<Row = unknown>(): Promise<Row | null>;
  async first<Value = unknown>(column: string): Promise<Value | null>;
  async first(column?: string): Promise<unknown> {
    const { results } = this.execute<Record<string, unknown>>();
    const row = results[0] ?? null;
    if (column === undefined) return row;
    if (row === null) return null;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column];
  }

  async run<Row = unknown>(): Promise<DatabaseResult<Row>> {
    return this.execute<Row>();
  }

  async all<Row = unknown>(): Promise<DatabaseResult<Row>> {
    return this.execute<Row>();
  }
}

class SqliteDatabase implements Database {
  readonly #driver: SqliteDriver;

  constructor(driver: SqliteDriver) {
    this.#driver = driver;
  }

  prepare(query: string): DatabaseStatement {
    return new SqliteStatement(this.#driver.prepare(query));
  }

  /**
   * Run every statement inside one immediate transaction.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front so a concurrent writer
   * cannot interleave and force a rollback midway. Statements execute through
   * the same path as a standalone call, so reads inside a batch return their
   * rows rather than an empty array.
   */
  async batch<Row = unknown>(statements: DatabaseStatement[]): Promise<DatabaseResult<Row>[]> {
    // Validated before the transaction opens, so a foreign statement cannot
    // leave a BEGIN behind that has to be rolled back.
    const owned = statements.map((statement) => {
      if (!(statement instanceof SqliteStatement)) {
        throw new TypeError("SQLite batches require statements prepared by this adapter");
      }
      return statement;
    });

    this.#driver.exec("BEGIN IMMEDIATE");
    try {
      // Deliberately synchronous: no await between statements, so nothing can
      // interleave inside the open transaction.
      const results = owned.map((statement) => statement.execute<Row>());
      this.#driver.exec("COMMIT");
      return results;
    } catch (error) {
      this.#driver.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Wrap a `better-sqlite3` connection as a `Database`.
 *
 * Foreign keys are enabled explicitly: SQLite leaves them off per connection by
 * default while D1 has them on, and the schema leans on them heavily enough that
 * the difference would let a Node host accept rows production rejects.
 */
export function createSqliteDatabase(driver: SqliteDriver): Database {
  driver.exec("PRAGMA foreign_keys = ON");
  return new SqliteDatabase(driver);
}
