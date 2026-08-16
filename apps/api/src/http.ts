import type { Context } from "hono";

import type { ApiErrorBody, Env, Variables } from "./types";

export function errorResponse(
  context: Context<{ Bindings: Env; Variables: Variables }>,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500 | 503,
  code: string,
  message: string,
  issues?: Array<{ field: string; message: string }>,
) {
  return context.json<ApiErrorBody>(
    {
      error: {
        code,
        message,
        requestId: context.get("requestId"),
        ...(issues ? { issues } : {}),
      },
    },
    status,
  );
}
