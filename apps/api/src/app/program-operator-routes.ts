import { programOperatorBriefResponseSchema } from "@confpilot/contracts";
import { Hono } from "hono";

import { requireEventRole } from "../auth";
import { errorResponse } from "../http";
import type { AppBindings } from "../types";
import {
  ProgramOperatorEventNotFoundError,
  getDailyProgramBrief,
} from "./program-operator-service";

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createProgramOperatorRoutes() {
  const routes = new Hono<AppBindings>();
  routes.use("/events/:eventSlug/program-operator/daily-brief", requireEventRole("organizer"));

  routes.get("/events/:eventSlug/program-operator/daily-brief", async (context) => {
    let brief;
    try {
      brief = await getDailyProgramBrief(context.env.DB, context.get("authEventId"), now());
    } catch (error) {
      if (error instanceof ProgramOperatorEventNotFoundError) {
        return errorResponse(context, 404, "EVENT_NOT_FOUND", "The requested event does not exist.");
      }
      throw error;
    }
    const parsed = programOperatorBriefResponseSchema.safeParse(brief);
    if (!parsed.success) {
      console.error("Program Operator brief contract violation", {
        requestId: context.get("requestId"),
        eventId: context.get("authEventId"),
        issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String) })),
      });
      return errorResponse(context, 500, "PROGRAM_OPERATOR_BRIEF_INVALID", "The daily program brief could not be produced safely.");
    }
    return context.json({ data: parsed.data, requestId: context.get("requestId") });
  });

  return routes;
}
