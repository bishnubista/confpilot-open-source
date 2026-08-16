/**
 * The Node host's configuration, resolved from the process environment.
 *
 * Cloudflare gets its configuration from `wrangler.jsonc` and its bindings from
 * the platform, both of which fail loudly when they are wrong. A Node host has
 * neither, so this module is where a misconfiguration has to be caught — and the
 * rule it follows is that a setting whose absence weakens a guarantee must be
 * refused, not defaulted. Every value below is either required, or has a default
 * that is safe when nobody thought about it.
 *
 * Two defaults are worth reading before changing:
 *
 * - **`HOST` binds to loopback.** A default of `0.0.0.0` publishes an app with no
 *   TLS of its own to every interface the machine has, and the operator finds out
 *   from someone else. Loopback fails visibly instead, and the container config
 *   sets `0.0.0.0` explicitly because there it is correct.
 * - **`CLIENT_IP_SOURCE` is left unset.** `runtime/client-ip.ts` reads anything
 *   unrecognised as "trust nothing", which over-throttles rather than believing a
 *   forged header. `wrangler.jsonc` sets `cloudflare` because Cloudflare's edge
 *   overwrites that header; nothing in front of a Node host is known to, so the
 *   operator has to say so.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface HostConfig {
  port: number;
  host: string;
  /** Browser-visible origin used for URL generation and same-origin mutation checks. */
  publicOrigin: string;
  /** SQLite file holding the application schema, the outbox, and limiter counters. */
  databasePath: string;
  /** Directory backing the private file store. Must not be served statically. */
  filesDirectory: string;
  /** Built SPA to serve for everything the API does not claim. */
  staticDirectory: string;
  /** Passed through to the app unchanged; the app validates its own semantics. */
  variables: Record<string, string>;
}

/** Settings the app reads off `env` and this host merely forwards. */
const PASSTHROUGH = [
  "CLIENT_IP_SOURCE",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_ALLOWED_HOSTNAMES",
  "CALENDAR_UID_DOMAIN",
  "EMAIL_DELIVERY_ENABLED",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_FROM_NAME",
  "EMAIL_DELIVERY_SEND_AFTER",
] as const;

export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostConfigError";
  }
}

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new HostConfigError(`${name} must be set. See .env.example for what each setting does.`);
  }
  return value;
}

function port(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 8787;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  // Rejected rather than coerced: `Number("8787abc")` is NaN and `parseInt` would
  // silently accept it as 8787, binding a port the operator did not ask for.
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new HostConfigError(`PORT must be a whole number between 1 and 65535, not ${JSON.stringify(value)}`);
  }
  return parsed;
}

function publicHttpUrl(
  source: Record<string, string | undefined>,
  name: string,
  options: { originOnly?: boolean; httpsExceptLoopback?: boolean } = {},
): string {
  const value = required(source, name);
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error();
    if (options.originOnly && (url.pathname !== "/" || url.search || url.hash)) throw new Error();
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (options.httpsExceptLoopback && url.protocol !== "https:" && !loopback) throw new Error();
    return options.originOnly ? url.origin : url.toString();
  } catch {
    const shape = options.httpsExceptLoopback
      ? "an HTTPS origin without a path, query, hash, or credentials (HTTP is allowed only on loopback)"
      : options.originOnly
        ? "an HTTP(S) origin without a path, query, hash, or credentials"
        : "an absolute HTTP(S) URL without credentials";
    throw new HostConfigError(`${name} must be ${shape}, not ${JSON.stringify(value)}.`);
  }
}

function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer + sep);
}

/**
 * Resolve a path through symlinks, as far as it exists.
 *
 * The overlap check below has to compare where paths *really* are, or a
 * symlinked `FILES_DIRECTORY` pointing inside the static root passes a string
 * comparison while its contents are genuinely public. `realpath` alone is not
 * enough because these paths legitimately may not exist yet — the database file
 * and the upload directory are both created on first boot — so this canonicalises
 * the deepest ancestor that does exist and re-attaches the rest.
 */
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  const unresolved: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...unresolved);
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without resolving anything: nothing on this
      // path exists, so its lexical form is the best answer available.
      if (parent === current) return absolute;
      unresolved.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Refuse a layout that would publish private data.
 *
 * The static handler serves everything under `STATIC_DIRECTORY` to anyone. Put
 * the database or the private file store beneath it and every unpublished
 * proposal, every headshot, and the session table are a URL away — no error, no
 * failing request, just a working server serving the wrong things.
 *
 * This was previously written down as a deployment obligation "this module
 * cannot enforce". That was wrong: the host knows all three paths at startup and
 * can simply refuse. A comment is not a control.
 *
 * Paths are canonicalised first. A lexical comparison catches the obvious
 * mistake — nesting one inside another — but not a symlinked `FILES_DIRECTORY`
 * whose real location is inside the static root, where the uploads genuinely are
 * public and the static handler serves them entirely correctly. That handler
 * resolves real paths too, but it defends a different thing: it stops requests
 * escaping the root, not private data being placed within it.
 */
async function refuseOverlap(
  config: Pick<HostConfig, "databasePath" | "filesDirectory" | "staticDirectory">,
): Promise<void> {
  const [database, files, staticRoot] = await Promise.all([
    canonical(config.databasePath), canonical(config.filesDirectory), canonical(config.staticDirectory),
  ]);

  for (const [name, path] of [["DATABASE_PATH", database], ["FILES_DIRECTORY", files]] as const) {
    if (within(path, staticRoot)) {
      throw new HostConfigError(
        `${name} must not be inside STATIC_DIRECTORY: everything under the static directory is served publicly, `
        + `so this would publish private data. It resolves to ${path}, inside ${staticRoot}.`,
      );
    }
  }
  if (within(staticRoot, files)) {
    throw new HostConfigError(
      `STATIC_DIRECTORY must not be inside FILES_DIRECTORY: uploads would be reachable as static assets. `
      + `It resolves to ${staticRoot}, inside ${files}.`,
    );
  }
  if (within(database, files)) {
    throw new HostConfigError(
      `DATABASE_PATH must not be inside FILES_DIRECTORY: the private file store rewrites and deletes files there. `
      + `It resolves to ${database}, inside ${files}.`,
    );
  }
}

export async function readHostConfig(source: Record<string, string | undefined>): Promise<HostConfig> {
  const variables: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = source[name]?.trim();
    if (value) variables[name] = value;
  }
  variables.SOURCE_URL = publicHttpUrl(source, "SOURCE_URL");
  if (source.BUILD_SOURCE_URL !== undefined) {
    const builtSourceUrl = publicHttpUrl(source, "BUILD_SOURCE_URL");
    if (builtSourceUrl !== variables.SOURCE_URL) {
      throw new HostConfigError(
        "SOURCE_URL must exactly match the Corresponding Source URL embedded in the built web application.",
      );
    }
  }

  const config: HostConfig = {
    port: port(source.PORT),
    host: source.HOST?.trim() || "127.0.0.1",
    publicOrigin: publicHttpUrl(source, "PUBLIC_ORIGIN", { originOnly: true, httpsExceptLoopback: true }),
    databasePath: required(source, "DATABASE_PATH"),
    filesDirectory: required(source, "FILES_DIRECTORY"),
    staticDirectory: required(source, "STATIC_DIRECTORY"),
    variables,
  };
  await refuseOverlap(config);
  return config;
}
