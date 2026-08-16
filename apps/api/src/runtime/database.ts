/**
 * The database capability, as the application actually uses it.
 *
 * Every other external capability in this directory is a port with at least two
 * implementations. The database was deliberately left as a raw `D1Database`
 * binding on the grounds that it had no second implementation — which was true
 * until hosting off Cloudflare became a goal.
 *
 * This interface is deliberately narrower than `D1Database`: it covers only
 * `prepare`, `bind`, `run`, `all`, `first`, and `batch`, which is the complete
 * surface used across every call site in `src/`. `exec`, `raw`, `dump`, and the
 * session APIs are unused and stay out, so an adapter does not have to implement
 * behaviour nothing depends on.
 *
 * The semantics below are not inferred from documentation. They were measured
 * against real D1 running under Miniflare, and `test/database-conformance.test.mjs`
 * asserts every one of them against each implementation. Where the two disagree,
 * the D1 behaviour is the contract, because that is what production runs today.
 */

/**
 * Statement metadata.
 *
 * D1 returns a much larger object (`served_by`, `duration`, `last_row_id`,
 * `rows_read`, and more), but `changes` is the only field any call site reads,
 * so it is the only one an adapter must produce. The index signature keeps D1's
 * extra fields assignable without inviting new dependencies on them.
 */
export interface DatabaseMeta {
  changes: number;
  [field: string]: unknown;
}

/**
 * The result of executing one statement.
 *
 * `results` carries rows for reads and is empty for writes. Note that this
 * applies to `run()` as well: against real D1 a `SELECT` executed with `run()`
 * returns its rows, exactly as `all()` does. Adapters that return an empty array
 * from `run()` look correct until a caller reads rows back from a batch.
 */
export interface DatabaseResult<Row = unknown> {
  success: boolean;
  results: Row[];
  meta: DatabaseMeta;
}

export interface DatabaseStatement {
  /** Bind positional parameters, returning a new bound statement. */
  bind(...values: unknown[]): DatabaseStatement;
  /** First row, or `null` when the query matched nothing. */
  first<Row = unknown>(): Promise<Row | null>;
  /** One column of the first row. Throws when the column is absent from the result. */
  first<Value = unknown>(column: string): Promise<Value | null>;
  run<Row = unknown>(): Promise<DatabaseResult<Row>>;
  all<Row = unknown>(): Promise<DatabaseResult<Row>>;
}

export interface Database {
  prepare(query: string): DatabaseStatement;
  /**
   * Execute statements as one atomic unit.
   *
   * Returns one result per statement, in order, with rows populated for reads.
   * If any statement fails the whole batch is rolled back and the error is
   * thrown — several write paths depend on this for their atomicity rather than
   * on an explicit transaction.
   */
  batch<Row = unknown>(statements: DatabaseStatement[]): Promise<DatabaseResult<Row>[]>;
}

/**
 * The number of bound parameters a single statement may carry.
 *
 * D1 rejects the 101st with `too many SQL variables`, measured rather than
 * assumed. Call sites that build an `IN (...)` list from user input must chunk
 * below this; the existing lookups use 90 to leave room for the other bindings
 * in the same statement.
 */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * The searchable text of a database failure, whatever driver raised it.
 *
 * Several call sites classify failures by matching the text of a `RAISE(ABORT)`
 * trigger or a UNIQUE constraint — the schema enforces authorization rules the
 * middleware also checks, and a rejection has to be told apart from a genuine
 * fault. That matching is only as portable as the string it reads.
 *
 * Drivers differ in where they put it. D1 prefixes its own message
 * (`D1_ERROR: UNIQUE constraint failed: ...`) while exposing the bare SQLite text
 * on `cause`; a direct SQLite driver sets only `message`. Both are concatenated
 * so a matcher finds the text without depending on which driver produced it, and
 * without depending on the error's class.
 *
 * Note this only normalizes — it deliberately does not classify. Deciding what a
 * given failure *means* stays at the call site, where the surrounding operation
 * is known.
 */
export function constraintMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (!(error instanceof Error)) return String(error ?? "");

  const { cause } = error;
  const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return causeText && causeText !== error.message ? `${error.message} ${causeText}` : error.message;
}
