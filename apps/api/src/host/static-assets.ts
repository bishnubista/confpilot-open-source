/**
 * Serve the built SPA the way Cloudflare's asset handler does.
 *
 * On Cloudflare this code does not exist: `wrangler.jsonc` declares an `assets`
 * directory with SPA fallback, and `run_worker_first` lists the only three paths
 * that reach the Worker at all. Everything else is served by the platform, with
 * `apps/web/public/_headers` supplying the response headers.
 *
 * A Node host has to reproduce all three of those, and the third is the one that
 * disappears quietly. `_headers` is a Cloudflare file format; nothing outside
 * Cloudflare reads it. Serve this app from Node without reimplementing it and
 * every protection in it is silently gone — no error, no failing test. So the
 * policy is taken from `runtime/security-headers.ts`, which is the same module
 * the committed `_headers` is generated from, and both hosts answer from one
 * source rather than two that agree by inspection.
 *
 * ## The headers follow the request, not the file
 *
 * SPA fallback serves `index.html` for `/admin`, but Cloudflare matches
 * `_headers` against the *requested* path. So `/admin` is framed-denied while
 * `/embed/anything` is not, even though both are answered with the same bytes.
 * Resolving headers from the file that happened to be served would collapse that
 * distinction and un-protect every authenticated route in one line.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { headersForPath } from "../runtime/security-headers";

/**
 * Paths the application answers, mirroring `run_worker_first` in `wrangler.jsonc`.
 *
 * `test/worker-config.test.mjs` pins the Cloudflare half, and the host test pins
 * this one against it, so a route added to one host cannot be missed on the other.
 */
export const APPLICATION_PATHS: readonly string[] = ["/api", "/api/*", "/llms.txt"];

export function isApplicationPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/llms.txt";
}

/**
 * Content types for what a Vite build actually emits.
 *
 * Deliberately a closed list. An unknown extension is served as
 * `application/octet-stream`, which downloads rather than executes — the failure
 * mode of guessing wrong is serving an attacker-influenced file as something the
 * browser will run.
 */
const CONTENT_TYPES = new Map<string, string>([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["gif", "image/gif"],
  ["ico", "image/x-icon"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["txt", "text/plain; charset=utf-8"],
  ["webmanifest", "application/manifest+json"],
  ["map", "application/json; charset=utf-8"],
]);

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES.get(extension) ?? "application/octet-stream";
}

/**
 * Resolve a request path to a file inside the root, or `null` if it escapes.
 *
 * The path is attacker-controlled, so this is a containment check rather than a
 * tidy-up. `resolve` collapses `..` before the comparison, which is what makes
 * the prefix test meaningful — comparing the unresolved string would pass
 * `/root/../../etc/passwd`. Encoded traversal is handled too, because the
 * decoding happens first and `%2e%2e` becomes `..` before resolution.
 */
export function resolveWithin(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path we can reason about, so it is not one we serve.
    return null;
  }
  if (decoded.includes("\0")) return null;

  const base = resolve(root);
  const candidate = resolve(join(base, decoded));
  return candidate === base || candidate.startsWith(base + sep) ? candidate : null;
}

async function readable(
  path: string,
  contains: (candidate: string) => Promise<boolean>,
): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> {
  try {
    // Checked here and not only in `resolveWithin`, because that check is
    // lexical and the filesystem is not: a symlink inside the build directory
    // pointing anywhere on the host passes a string comparison and then serves
    // the target's bytes as same-origin content — an arbitrary file becomes
    // executable JavaScript on this origin. `realpath` is what closes it.
    if (!await contains(path)) return null;
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    // `Readable.toWeb` is typed ReadableStream<any>; the cast names the chunk
    // type rather than widening it, and a byte-mode fs stream yields Buffers.
    return { size: stats.size, body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array> };
  } catch {
    return null;
  }
}

export interface StaticAssetHandler {
  (request: Request): Promise<Response | null>;
}

/**
 * Build a handler for everything the application does not claim.
 *
 * Returns `null` for application paths so the caller can route them onward,
 * rather than deciding here what an unhandled request means.
 */
export function createStaticAssetHandler(directory: string): StaticAssetHandler {
  /**
   * True when `candidate` really is inside the build directory, symlinks and
   * all. Both sides are resolved, because a link anywhere in the chain — the
   * root itself included — makes a lexical prefix test meaningless.
   */
  const contains = async (candidate: string): Promise<boolean> => {
    try {
      const [root, real] = await Promise.all([realpath(resolve(directory)), realpath(candidate)]);
      return real === root || real.startsWith(root + sep);
    } catch {
      // A path that cannot be resolved is not one we serve.
      return false;
    }
  };

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (isApplicationPath(pathname)) return null;
    if (request.method !== "GET" && request.method !== "HEAD") return null;

    // Resolved against the request path, never the file finally served — see the
    // module note. `/admin` denies framing whether it hits a file or the fallback.
    const headers = new Headers([...headersForPath(pathname)]);
    const body = (file: { body: ReadableStream<Uint8Array> }) =>
      request.method === "HEAD" ? null : file.body;

    const target = resolveWithin(directory, pathname);
    if (target !== null) {
      const file = await readable(target, contains);
      if (file) {
        headers.set("content-type", contentType(target));
        headers.set("content-length", String(file.size));
        return new Response(body(file), { headers });
      }
    }

    // Falls back for every miss, including paths that look like assets. That is
    // what `not_found_handling: "single-page-application"` does, so a missing
    // script answers 200 with HTML on both hosts. Returning 404 here would be the
    // friendlier behaviour and the wrong one: this module exists to make a Node
    // deployment behave like the Cloudflare one, and a deliberate improvement on
    // one host is the divergence it is trying to prevent.
    const index = await readable(join(resolve(directory), "index.html"), contains);
    if (!index) {
      return new Response("The web build is missing. Run the build before starting the server.", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-length", String(index.size));
    return new Response(body(index), { headers });
  };
}
