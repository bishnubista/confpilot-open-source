import type { Hono } from "hono";

import { createAuthRoutes } from "../auth-routes";
import { createAgendaRoutes } from "../features/agenda/agenda-routes";
import { createCfpRoutes } from "../features/cfp/cfp-routes";
import { createDecisionRoutes } from "../features/decisions/decision-routes";
import { createEventInvitationRoutes } from "../event-invitation-routes";
import { createSpeakerClaimRoutes } from "../speaker-claim-routes";
import { createCommunicationRoutes } from "../features/messaging/communication-routes";
import { createCalendarRoutes } from "../features/publication/calendar-routes";
import {
  createEmbedRoutes,
  createPublicProgramRoutes,
} from "../features/publication/embed-routes";
import { createReviewRoutes } from "../features/review/review-routes";
import { createSpeakerContentHandlers } from "../features/speakers/speaker-content-handlers";
import { createSpeakerContentRoutes } from "../features/speakers/speaker-content-routes";
import type { AppBindings } from "../types";
import { createAgentRoutes } from "./agent-routes";
import { createDiscoveryRoutes } from "./discovery-routes";
import { createPlatformRoutes } from "./platform-routes";
import { createProgramOperatorRoutes } from "./program-operator-routes";

export interface FeatureModule {
  /** Stable identifier for the lifecycle stage this module owns. */
  name: string;
  /** Prefix the module's router is mounted under. */
  basePath: string;
  /** What this module is responsible for, for contributors reading the manifest first. */
  summary: string;
  createRoutes(): Hono<AppBindings>;
}

/**
 * The lifecycle, in the order it is mounted.
 *
 * **Order is significant.** Hono matches routes in registration order, and
 * several modules declare overlapping patterns under the shared `/api` prefix
 * (for example the anonymous `/cfp/:eventSlug` surface versus the organizer
 * `/events/:eventSlug/cfp` surface). Reordering entries can silently change
 * which handler answers a request, so treat this array as behaviour rather than
 * presentation and re-run the route tests after any change.
 *
 * `agent` sits immediately before `platform` and registers only the literal
 * `/api/agent/manifest`, which no pattern above it can match, so its position is
 * safe but not load-bearing.
 *
 * `platform` is deliberately the last `/api` module: it registers the broad
 * `/events` listing, which must not shadow the feature-specific
 * `/events/:eventSlug/...` routes declared above it. `discovery` follows it but
 * mounts at `/` and serves only `/llms.txt`, so it cannot shadow an `/api` route.
 */
export const featureManifest: readonly FeatureModule[] = [
  {
    name: "identity",
    basePath: "/api/auth",
    summary: "Credential sign-in, opaque hashed sessions, and sign-out.",
    createRoutes: createAuthRoutes,
  },
  {
    name: "event-invitations",
    basePath: "/api",
    summary: "Expiring reviewer invitations, identity-bound account creation, and single-use membership claims.",
    createRoutes: createEventInvitationRoutes,
  },
  {
    name: "speaker-claims",
    basePath: "/api",
    summary: "Expiring identity-bound claims for organizer-created speaker profiles.",
    createRoutes: createSpeakerClaimRoutes,
  },
  {
    name: "cfp",
    basePath: "/api",
    summary: "Public CFP configuration, speaker registration, drafts, and submission.",
    createRoutes: createCfpRoutes,
  },
  {
    name: "review",
    basePath: "/api",
    summary: "Versioned evaluation plans, reviewer assignments, self-review prevention, revocation, and immutable scorecards.",
    createRoutes: createReviewRoutes,
  },
  {
    name: "decisions",
    basePath: "/api",
    summary: "Aggregate scoring, decisions, idempotent acceptance, and notification intent.",
    createRoutes: createDecisionRoutes,
  },
  {
    name: "communications",
    basePath: "/api",
    summary: "Organizer-scoped immutable communication history and exact-recipient outbox controls.",
    createRoutes: createCommunicationRoutes,
  },
  {
    name: "agenda",
    basePath: "/api",
    summary: "Multi-day scheduling, conflict detection, auto-fill, and publication.",
    createRoutes: createAgendaRoutes,
  },
  {
    name: "publication",
    basePath: "/api",
    summary: "Anonymous public program plus rendered, JSON, and filtered iCalendar embed output.",
    createRoutes: createPublicProgramRoutes,
  },
  {
    name: "publication:calendar",
    basePath: "/api",
    summary: "Stable-identity iCalendar export for the published program.",
    createRoutes: createCalendarRoutes,
  },
  {
    name: "publication:embeds",
    basePath: "/api",
    summary: "Saved embed configurations with revision-guarded presentation and distribution paths.",
    createRoutes: createEmbedRoutes,
  },
  {
    name: "speakers",
    basePath: "/api",
    summary: "Unclaimed roster intake, speaker profiles, onboarding tasks, private uploads, and content approval.",
    createRoutes: () => createSpeakerContentRoutes(createSpeakerContentHandlers()),
  },
  {
    name: "program-operator",
    basePath: "/api",
    summary: "Organizer-scoped shadow-mode daily briefs, ranked evidence, and approval-gated reminder drafts.",
    createRoutes: createProgramOperatorRoutes,
  },
  {
    name: "agent",
    basePath: "/api",
    summary: "Machine-readable catalog of the authenticated surface for AI agents: roles, retry semantics, and the same-origin mutation preamble.",
    createRoutes: createAgentRoutes,
  },
  {
    name: "platform",
    basePath: "/api",
    summary: "Liveness, organizer-scoped draft event creation, the published event index, and the derived readiness trail.",
    createRoutes: createPlatformRoutes,
  },
  {
    name: "discovery",
    basePath: "/",
    summary: "Root-level /llms.txt describing this instance for AI agents and crawlers.",
    createRoutes: createDiscoveryRoutes,
  },
];
