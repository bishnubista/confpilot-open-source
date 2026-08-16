import { loginRequestSchema, type AuthSession } from "@confpilot/contracts";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { SESSION_COOKIE, getAuthenticatedSession, hashToken } from "./auth";
import { errorResponse } from "./http";
import {
  PASSWORD_ALGORITHM,
  PASSWORD_ITERATIONS,
  constantTimeHexEqual,
  derivePasswordHash,
} from "./password";
import type { AppBindings } from "./types";
import { requestSource } from "./runtime/client-ip";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DUMMY_SALT = "35c32d0e250b55a72af95527e1b19edc";
const DUMMY_HASH = "9d14a158f44161991f864e9e2ec9f49e3563e158193ad43955631c36f35ee6a1";

interface CredentialRow {
  userId: string;
  email: string;
  displayName: string;
  passwordSalt: string;
  passwordHash: string;
  algorithm: string;
  iterations: number;
}

interface MembershipRow {
  eventSlug: string;
  role: "organizer" | "reviewer" | "speaker";
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function rateLimitKey(scope: "source" | "account", value: string) {
  return hashToken(`login:${scope}:${value}`);
}

function rateLimited(context: Context<AppBindings>) {
  context.header("retry-after", "60");
  return errorResponse(
    context,
    429,
    "LOGIN_RATE_LIMITED",
    "Too many sign-in attempts. Wait a minute and try again.",
  );
}

async function deriveLoginHash(password: string, salt: string, iterations: number) {
  const credentialMaterialSupported = iterations === PASSWORD_ITERATIONS
    && /^[0-9a-f]{32}$/.test(salt);
  try {
    return {
      hash: await derivePasswordHash(
        password,
        credentialMaterialSupported ? salt : DUMMY_SALT,
        PASSWORD_ITERATIONS,
      ),
      credentialMaterialValid: credentialMaterialSupported,
    };
  } catch {
    return null;
  }
}

export async function sessionProjection(
  context: Context<AppBindings>,
  user: { userId: string; email: string; displayName: string },
): Promise<AuthSession> {
  const { results: memberships } = await context.env.DB.prepare(
    `SELECT event.slug AS eventSlug, membership.role AS role
    FROM event_memberships AS membership
    INNER JOIN events AS event ON event.id = membership.event_id
    WHERE membership.user_id = ?
    ORDER BY event.starts_on ASC, event.slug ASC,
      CASE membership.role WHEN 'organizer' THEN 0 WHEN 'reviewer' THEN 1 ELSE 2 END`,
  ).bind(user.userId).all<MembershipRow>();

  return {
    user: { id: user.userId, email: user.email, displayName: user.displayName },
    memberships,
  };
}

export async function issueSession(context: Context<AppBindings>, userId: string) {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1_000);
  const currentToken = getCookie(context, SESSION_COOKIE, "host");
  const statements = [];
  if (currentToken && currentToken.length <= 512) {
    statements.push(
      context.env.DB.prepare(
        `UPDATE auth_sessions
        SET revoked_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL`,
      ).bind(now.toISOString(), await hashToken(currentToken)),
    );
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO auth_sessions (
        id, user_id, token_hash, expires_at, revoked_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      await hashToken(token),
      expiresAt.toISOString(),
      now.toISOString(),
    ),
  );
  await context.env.DB.batch(statements);

  setCookie(context, SESSION_COOKIE, token, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_SECONDS,
    priority: "High",
  });
}

async function parseLogin(context: Context<AppBindings>) {
  let input: unknown;
  try {
    input = await context.req.json();
  } catch {
    return errorResponse(context, 400, "INVALID_JSON", "The request body must be valid JSON.");
  }

  const result = loginRequestSchema.safeParse(input);
  if (!result.success) {
    return errorResponse(context, 400, "VALIDATION_FAILED", "Check the submitted fields and try again.");
  }
  return result.data;
}

export function createAuthRoutes() {
  const routes = new Hono<AppBindings>();

  routes.post("/login", async (context) => {
    const source = requestSource(context);
    const sourceLimit = await context.env.LOGIN_SOURCE_RATE_LIMITER.limit({
      key: await rateLimitKey("source", source),
    });
    if (!sourceLimit.success) {
      return rateLimited(context);
    }

    const input = await parseLogin(context);
    if (input instanceof Response) return input;

    const accountLimit = await context.env.LOGIN_ACCOUNT_RATE_LIMITER.limit({
      key: await rateLimitKey("account", input.email),
    });
    if (!accountLimit.success) {
      return rateLimited(context);
    }

    const credential = await context.env.DB.prepare(
      `SELECT
        user.id AS userId,
        lower(trim(user.email)) AS email,
        user.display_name AS displayName,
        credential.password_salt AS passwordSalt,
        credential.password_hash AS passwordHash,
        credential.algorithm AS algorithm,
        credential.iterations AS iterations
      FROM users AS user
      INNER JOIN user_credentials AS credential ON credential.user_id = user.id
      WHERE lower(trim(user.email)) = ?
      LIMIT 1`,
    ).bind(input.email).first<CredentialRow>();

    const structurallyValid = credential !== null
      && credential.algorithm === PASSWORD_ALGORITHM
      && credential.iterations === PASSWORD_ITERATIONS
      && /^[0-9a-f]{32}$/.test(credential.passwordSalt)
      && /^[0-9a-f]{64}$/.test(credential.passwordHash);
    const derived = await deriveLoginHash(
      input.password,
      credential && structurallyValid ? credential.passwordSalt : DUMMY_SALT,
      credential && structurallyValid ? credential.iterations : PASSWORD_ITERATIONS,
    );
    if (!derived) {
      return errorResponse(context, 503, "LOGIN_UNAVAILABLE", "Sign in is temporarily unavailable. Try again shortly.");
    }
    const passwordMatches = constantTimeHexEqual(
      derived.hash,
      credential?.passwordHash ?? DUMMY_HASH,
    );
    if (!credential || !structurallyValid || !derived.credentialMaterialValid || !passwordMatches) {
      return errorResponse(context, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }

    await issueSession(context, credential.userId);
    return context.json({
      data: await sessionProjection(context, credential),
      requestId: context.get("requestId"),
    });
  });

  routes.get("/session", async (context) => {
    const session = await getAuthenticatedSession(context);
    if (!session) {
      return errorResponse(context, 401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    return context.json({
      data: await sessionProjection(context, session),
      requestId: context.get("requestId"),
    });
  });

  routes.post("/logout", async (context) => {
    const token = getCookie(context, SESSION_COOKIE, "host");
    if (token && token.length <= 512) {
      await context.env.DB.prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      ).bind(new Date().toISOString(), await hashToken(token)).run();
    }
    deleteCookie(context, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
    return context.body(null, 204);
  });

  return routes;
}
