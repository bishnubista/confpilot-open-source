/**
 * Node host entry point.
 *
 * The Worker entry is nine lines because Cloudflare supplies everything around
 * it: bindings, static assets, response headers, a cron trigger, TLS. This file
 * is the same application with each of those supplied explicitly, and it is the
 * only place in the codebase that knows it is running on Node.
 *
 * The application itself is untouched. `createApp()` is the same composition the
 * Worker mounts, and it reads its capabilities off `env` per request exactly as
 * before — so what follows is assembly, not a second implementation. Anything
 * here that had to reproduce a platform behaviour rather than plug in an adapter
 * says so in its own module: `static-assets.ts` for the header policy,
 * `migrations.ts` for the deploy step, `scheduler.ts` for the cron.
 *
 * ## What this does not do
 *
 * No TLS. A container behind a reverse proxy is the expected deployment, and a
 * server that terminates TLS itself would need certificate management this
 * project has no business owning. `HOST` therefore defaults to loopback — see
 * `config.ts` — so an unproxied instance is unreachable rather than unprotected.
 */
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import BetterSqlite3 from "better-sqlite3";

import { createApp } from "./app/create-app";
import { runScheduledEmailDispatch } from "./app/email-dispatch";
import { readHostConfig } from "./host/config";
import { applyMigrations } from "./host/migrations";
import { startScheduler } from "./host/scheduler";
import { configureSqliteConnection } from "./host/sqlite-connection";
import { createStaticAssetHandler } from "./host/static-assets";
import { createDatabaseRateLimiter } from "./runtime/database-rate-limiter";
import { createFilesystemPrivateFileStore } from "./runtime/filesystem-file-store";
import { LOGIN_RATE_LIMITS } from "./runtime/rate-limiter";
import type { Env } from "./types";

/**
 * The Worker's `ExecutionContext`, as much of it as the application uses.
 *
 * `waitUntil` on Cloudflare keeps the isolate alive past the response. A Node
 * process is already alive, so the work only needs somewhere for its failures to
 * go — dropping the promise would make a rejection an unhandled one and, on
 * newer Node, take the process down.
 */
function executionContext(onError: (error: unknown) => void) {
  return {
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(onError);
    },
    passThroughOnException() {},
    // Hono's ExecutionContext carries these for Wrangler compatibility. Nothing
    // in this application reads them, so they are present and empty rather than
    // faked into something that looks meaningful.
    props: undefined,
  };
}

/** Never log provider messages or anything carrying a recipient. */
function reportError(scope: string) {
  return (error: unknown) => {
    console.error(`${scope} failed`, { errorName: error instanceof Error ? error.name : "UnknownError" });
  };
}

/**
 * Replace the adapter's cleartext hop origin with the configured browser origin.
 *
 * Forwarded headers are deliberately ignored: unless a proxy is known to erase
 * client-supplied values, trusting them would let a caller choose the origin used
 * by the CSRF guard and by generated absolute URLs.
 */
export function requestAtPublicOrigin(request: Request, publicOrigin: string): Request {
  const internal = new URL(request.url);
  const external = new URL(publicOrigin);
  // Assign components rather than resolving a path string. A request path that
  // begins with `//` must remain a path, never become a new URL authority.
  external.pathname = internal.pathname;
  external.search = internal.search;
  return new Request(external, request);
}

export async function startServer(source: NodeJS.ProcessEnv = process.env) {
  const config = await readHostConfig(source);

  const connection = configureSqliteConnection(new BetterSqlite3(config.databasePath));
  // `fileURLToPath`, not `.pathname`: the latter leaves percent-escapes in place,
  // so a checkout under a directory with a space in its name silently resolves to
  // a path that does not exist. Overridable because a container is free to put
  // the migrations somewhere other than beside the bundle.
  const migrationsDirectory = source.MIGRATIONS_DIRECTORY
    ?? fileURLToPath(new URL("../migrations/", import.meta.url));
  const applied = await applyMigrations(connection.driver, migrationsDirectory);
  if (applied.length > 0) console.log(`Applied ${applied.length} migration(s)`);

  const env = {
    ...config.variables,
    DB: connection.database,
    FILES: createFilesystemPrivateFileStore(config.filesDirectory),
    [LOGIN_RATE_LIMITS.source.binding]: await createDatabaseRateLimiter(connection.database, {
      bucket: LOGIN_RATE_LIMITS.source.binding, ...LOGIN_RATE_LIMITS.source,
    }),
    [LOGIN_RATE_LIMITS.account.binding]: await createDatabaseRateLimiter(connection.database, {
      bucket: LOGIN_RATE_LIMITS.account.binding, ...LOGIN_RATE_LIMITS.account,
    }),
    // EMAIL is absent deliberately. `resolveEmailDeliveryRuntime` reads a missing
    // binding as delivery being unconfigured and returns a disabled sender, which
    // leaves the outbox queued rather than dropping messages. A Node host gains
    // an SMTP adapter here when one exists; until then, saying so beats pretending.
  } as unknown as Env;

  const app = createApp();
  const staticAssets = createStaticAssetHandler(config.staticDirectory);
  const context = executionContext(reportError("Background work"));

  const server = serve({
    port: config.port,
    hostname: config.host,
    // Assets first, mirroring `run_worker_first`: on Cloudflare only `/api`,
    // `/api/*` and `/llms.txt` reach the application at all, and the handler
    // returns null for exactly those so they fall through here.
    fetch: async (request: Request) => {
      const publicRequest = requestAtPublicOrigin(request, config.publicOrigin);
      return (await staticAssets(publicRequest)) ?? app.fetch(publicRequest, env, context);
    },
  });

  const scheduler = startScheduler(
    () => runScheduledEmailDispatch(env, Date.now()),
    { onError: reportError("Scheduled email dispatch") },
  );

  const shutdown = async () => {
    // Ordered so nothing is still using the database when it closes: stop
    // accepting requests, let the in-flight tick finish, then close the file.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler.stop();
    connection.close();
  };

  return { server, shutdown, config };
}

// Started only when run directly, so a test or a script can import `startServer`
// without a listener appearing as a side effect of the import.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { shutdown, config } = await startServer();
  console.log(`ConfPilot listening on http://${config.host}:${config.port} for ${config.publicOrigin}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      shutdown().then(() => process.exit(0), (error: unknown) => {
        reportError("Shutdown")(error);
        process.exit(1);
      });
    });
  }
}
