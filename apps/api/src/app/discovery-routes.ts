import { Hono } from "hono";

import type { AppBindings } from "../types";
import { sourceUrl } from "./source-offer";

interface DiscoveryEventRow {
  slug: string;
  name: string;
  tagline: string;
  location: string;
  startsOn: string;
  endsOn: string;
}

/**
 * Collapse anything that would break a single-line Markdown list item.
 *
 * Event names and taglines are organizer-supplied text. This is a rendering
 * concern, not a security boundary: the response is `text/plain`, so the only
 * risk is a malformed document rather than injection.
 */
function inlineText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Machine-readable description of this instance for AI agents and crawlers.
 *
 * Follows the llms.txt convention: an H1, a blockquote summary, then H2 sections
 * of Markdown links. It is generated from the same published-event rows the
 * public program serves, so it cannot advertise an event that is not actually
 * public. To keep the anonymous document bounded, it lists at most the 50 most
 * recently starting published events, presented in chronological order, and
 * says when additional published events were omitted.
 */
export function createDiscoveryRoutes() {
  const routes = new Hono<AppBindings>();

  routes.get("/llms.txt", async (context) => {
    const publishedSourceUrl = sourceUrl(context.env.SOURCE_URL);
    if (!publishedSourceUrl) {
      return context.text(
        "ConfPilot source offer is unavailable because SOURCE_URL is invalid.",
        503,
        { "cache-control": "private, no-store" },
      );
    }
    const origin = new URL(context.req.url).origin;
    const { results: events } = await context.env.DB
      .prepare(
        `SELECT
          slug,
          name,
          tagline,
          location,
          starts_on AS startsOn,
          ends_on AS endsOn
        FROM events
        WHERE status = 'published'
        ORDER BY starts_on DESC
        LIMIT 51`,
      )
      .all<DiscoveryEventRow>();
    const omittedEvents = events.length > 50;
    const listedEvents = events.slice(0, 50).reverse();

    const lines = [
      "# ConfPilot",
      "",
      "> A conference program platform serving this site's call for papers, schedule, and speaker information. The endpoints below return structured data and are the preferred way to read this site programmatically.",
      "",
      "This instance is self-hosted. Data is scoped per event; only published events appear here.",
      "",
    ];

    if (listedEvents.length === 0) {
      lines.push(
        "## Events",
        "",
        "No published events yet.",
        "",
      );
    } else {
      lines.push("## Events", "");
      for (const event of listedEvents) {
        const summary = [inlineText(event.tagline), inlineText(event.location)]
          .filter(Boolean)
          .join(" — ");
        lines.push(
          `- **${inlineText(event.name)}**: ${summary || "Conference program"} (${event.startsOn} to ${event.endsOn})`,
        );
      }
      if (omittedEvents) lines.push("- Additional published events are omitted from this bounded index.");
      lines.push("");

      lines.push("## Structured data", "");
      for (const event of listedEvents) {
        lines.push(
          `- [${inlineText(event.name)} — sessions and speakers (JSON)](${origin}/api/program?event=${event.slug}): full published program`,
          `- [${inlineText(event.name)} — speakers (JSON)](${origin}/api/program/speakers?event=${event.slug}): speaker profiles for the published program`,
          `- [${inlineText(event.name)} — schedule (iCalendar)](${origin}/api/program.ics?event=${event.slug}): importable calendar with stable event identities`,
          `- [${inlineText(event.name)} — call for papers (JSON)](${origin}/api/cfp/${event.slug}): CFP status, deadlines, and submission fields`,
        );
      }
      lines.push("");
    }

    lines.push(
      "## Operating this instance",
      "",
      `- [Agent manifest (JSON)](${origin}/api/agent/manifest): every authenticated operation, the role it needs, whether a repeat is safe, and the headers each mutation must carry`,
      "",
      "## About this software",
      "",
      `- [ConfPilot source code](${publishedSourceUrl}): this instance runs ConfPilot, licensed under AGPL-3.0-or-later`,
      "",
      "## Notes",
      "",
      "- All endpoints listed above are anonymous, read-only, and return JSON except the iCalendar feed.",
      "- A CFP reports `state` as `upcoming`, `open`, or `closed`; check it before telling a user they can submit.",
      "- Unpublished sessions, speaker contact details, uploaded files, and review data are never exposed here and require an authenticated role.",
      "- Submitting a proposal requires an account and, on most instances, passing a bot check. It cannot be completed through these read-only endpoints.",
      "- Any write requires a signed-in session and a same-origin request preamble. The agent manifest above documents both.",
      "",
    );

    return context.body(lines.join("\n"), 200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  });

  return routes;
}
