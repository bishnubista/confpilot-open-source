/**
 * The operation catalog an AI agent needs to drive this instance.
 *
 * `/llms.txt` describes what an anonymous reader can *fetch*. This catalog
 * describes what an authenticated caller can *do*, which is the part a
 * non-browser client cannot discover on its own: the same-origin preamble every
 * mutation must carry, which role each operation needs, and whether a repeat is
 * safe after a network failure.
 *
 * It lives in `app/` rather than in a feature because it spans every lifecycle
 * stage, and features never import one another. Nothing here reaches into
 * feature code: the catalog is data, and `agent-manifest.test.ts` reconciles it
 * against the composed Hono route table in both directions, so an operation
 * cannot be added, removed, or renamed without the catalog following.
 */

import type { EventRole } from "../types";

export const AGENT_MANIFEST_VERSION = 1;

/** The audience a caller must hold for the event named in the path. */
export type OperationRole = "anonymous" | "authenticated" | EventRole;

/**
 * What happens when an agent repeats a request it is not sure landed.
 *
 * Every value is a claim about code in this repository, not an aspiration. A
 * new operation defaults to `unsafe` until its guard is verified.
 */
export type RetryMode =
  /** Repeating with the same input has no additional effect. */
  | "safe"
  /** Repeating an identical request returns the existing record; a conflicting one is rejected with 409. */
  | "replay"
  /** A duplicate cannot be created, but a repeat answers 409 rather than returning the record. */
  | "guarded"
  /** The caller supplies an idempotency key, so a repeat is treated as the same write. See `idempotency`. */
  | "idempotency-key"
  /** A repeat may create a duplicate. Read current state back before retrying. */
  | "unsafe";

/**
 * Whether a human should confirm before the operation runs.
 *
 * `human` marks operations that publish, notify, decide someone's proposal, or
 * write a record this software treats as immutable. It is advice to the agent
 * author, not an authorization check — the API enforces roles regardless.
 */
export type ApprovalMode = "none" | "human";

/**
 * Where a `retry: "idempotency-key"` operation expects its key.
 *
 * The location is not uniform: multipart uploads carry it as a header because
 * there is no JSON body to put it in, while JSON operations validate it as a
 * required body field. An agent that guesses wrong gets a 400, so the manifest
 * states which one each operation uses.
 */
export interface IdempotencyKeyLocation {
  in: "header" | "body";
  name: string;
  required: boolean;
}

export interface AgentOperation {
  /** Stable identifier. Paths may be renamed; this is what an agent binds to. */
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path as registered on the router, with `:name` parameter placeholders. */
  path: string;
  /** Lifecycle stage, matching the name declared in the feature manifest. */
  stage: string;
  summary: string;
  role: OperationRole;
  retry: RetryMode;
  approval: ApprovalMode;
  /** Present exactly when `retry` is `idempotency-key`. */
  idempotency?: IdempotencyKeyLocation;
}

const IDEMPOTENCY_HEADER: IdempotencyKeyLocation = {
  in: "header",
  name: "Idempotency-Key",
  required: true,
};

const IDEMPOTENCY_BODY: IdempotencyKeyLocation = {
  in: "body",
  name: "idempotencyKey",
  required: true,
};

function operation(
  id: string,
  method: AgentOperation["method"],
  path: string,
  stage: string,
  role: OperationRole,
  retry: RetryMode,
  summary: string,
  approval: ApprovalMode = "none",
  idempotency?: IdempotencyKeyLocation,
): AgentOperation {
  return { id, method, path, stage, role, retry, approval, summary, ...(idempotency ? { idempotency } : {}) };
}

/**
 * Every route the composed app registers, annotated.
 *
 * Ordered by lifecycle stage so an agent reading top to bottom sees the same
 * progression the product does: sign in, open a CFP, collect, review, decide,
 * onboard, schedule, publish.
 */
export const agentOperations: readonly AgentOperation[] = [
  // identity
  operation("identity.signIn", "POST", "/api/auth/login", "identity", "anonymous", "unsafe",
    "Exchange email and password for a session cookie. Each successful call issues a new session, so an uncertain retry may create another session; retain the returned cookie before retrying."),
  operation("identity.session", "GET", "/api/auth/session", "identity", "anonymous", "safe",
    "Report the signed-in user and their event memberships, or an anonymous result."),
  operation("identity.signOut", "POST", "/api/auth/logout", "identity", "anonymous", "safe",
    "Revoke the presented session."),

  // event invitations
  operation("invitations.listReviewerInvitations", "GET", "/api/events/:eventSlug/reviewer-invitations", "event-invitations", "organizer", "safe",
    "List reviewer account invitations and their outbox state for this event."),
  operation("invitations.createReviewerInvitation", "POST", "/api/events/:eventSlug/reviewer-invitations", "event-invitations", "organizer", "idempotency-key",
    "Create and queue a single-use reviewer invitation. `idempotencyKey` is a required body field.", "human", IDEMPOTENCY_BODY),
  operation("invitations.revokeReviewerInvitation", "POST", "/api/events/:eventSlug/reviewer-invitations/:invitationId/revoke", "event-invitations", "organizer", "guarded",
    "Revoke a pending reviewer invitation and cancel its queued message.", "human"),
  operation("invitations.resolveReviewerInvitation", "POST", "/api/reviewer-invitations/resolve", "event-invitations", "anonymous", "safe",
    "Resolve a single-use reviewer token to its event and invited identity without accepting it."),
  operation("invitations.acceptReviewerInvitation", "POST", "/api/reviewer-invitations/accept", "event-invitations", "authenticated", "guarded",
    "Accept a single-use reviewer invitation using a signed-in account with the invited email.", "human"),
  operation("invitations.registerReviewer", "POST", "/api/reviewer-invitations/register", "event-invitations", "anonymous", "guarded",
    "Create an account with the invited email and consume a single-use reviewer invitation.", "human"),

  // speaker claims
  operation("speakerClaims.list", "GET", "/api/events/:eventSlug/speaker-claims", "speaker-claims", "organizer", "safe",
    "List account claims for organizer-created speaker profiles."),
  operation("speakerClaims.create", "POST", "/api/events/:eventSlug/speaker-claims", "speaker-claims", "organizer", "idempotency-key",
    "Create and queue a single-use speaker-profile claim. `idempotencyKey` is a required body field.", "human", IDEMPOTENCY_BODY),
  operation("speakerClaims.revoke", "POST", "/api/events/:eventSlug/speaker-claims/:claimId/revoke", "speaker-claims", "organizer", "guarded",
    "Revoke a pending speaker-profile claim and cancel its queued message.", "human"),
  operation("speakerClaims.resolve", "POST", "/api/speaker-claims/resolve", "speaker-claims", "anonymous", "safe",
    "Resolve a single-use speaker claim token without accepting it."),
  operation("speakerClaims.accept", "POST", "/api/speaker-claims/accept", "speaker-claims", "authenticated", "guarded",
    "Bind an unclaimed speaker profile to the signed-in account with the invited email.", "human"),
  operation("speakerClaims.register", "POST", "/api/speaker-claims/register", "speaker-claims", "anonymous", "guarded",
    "Create an account with the profile email and consume a single-use speaker claim.", "human"),

  // platform
  operation("platform.health", "GET", "/api/health", "platform", "anonymous", "safe",
    "Liveness and database reachability for this instance."),
  operation("platform.listEvents", "GET", "/api/events", "platform", "anonymous", "safe",
    "Index of published events on this instance."),
  operation("platform.createEvent", "POST", "/api/events", "platform", "authenticated", "guarded",
    "Create a draft event workspace. Requires an existing organizer membership; a taken slug answers 409.",
    "human"),
  operation("platform.readiness", "GET", "/api/events/:eventSlug/readiness", "platform", "organizer", "safe",
    "Derived readiness trail. The next operational blocker for the event, computed from lifecycle rows."),

  // cfp
  operation("cfp.publicStatus", "GET", "/api/cfp/:eventSlug", "cfp", "anonymous", "safe",
    "CFP state (upcoming, open, closed), deadlines, and submission fields."),
  operation("cfp.register", "POST", "/api/cfp/:eventSlug/register", "cfp", "anonymous", "guarded",
    "Create a speaker account for this event. May require a bot check.", "human"),
  operation("cfp.join", "POST", "/api/cfp/:eventSlug/join", "cfp", "authenticated", "safe",
    "Add a speaker membership for this event to the signed-in account."),
  operation("cfp.readConfig", "GET", "/api/events/:eventSlug/cfp", "cfp", "organizer", "safe",
    "Current CFP configuration."),
  operation("cfp.writeConfig", "PUT", "/api/events/:eventSlug/cfp", "cfp", "organizer", "safe",
    "Replace the CFP configuration, including the public deadline.", "human"),
  operation("cfp.listSubmitted", "GET", "/api/events/:eventSlug/cfp/proposals", "cfp", "organizer", "safe",
    "Submitted proposals for the organizer view."),
  operation("cfp.listOwnProposals", "GET", "/api/events/:eventSlug/proposals", "cfp", "speaker", "safe",
    "The signed-in speaker's own proposals, including drafts."),
  operation("cfp.createProposal", "POST", "/api/events/:eventSlug/proposals", "cfp", "speaker", "unsafe",
    "Create a proposal draft. A repeat creates a second draft; list first when retrying."),
  operation("cfp.readProposal", "GET", "/api/events/:eventSlug/proposals/:proposalId", "cfp", "speaker", "safe",
    "Read one of the signed-in speaker's proposals."),
  operation("cfp.listProposalParticipants", "GET", "/api/events/:eventSlug/proposals/:proposalId/participants", "cfp", "speaker", "safe",
    "List the owner and co-presenters on one of the signed-in speaker's proposals."),
  operation("cfp.addCoPresenter", "POST", "/api/events/:eventSlug/proposals/:proposalId/co-presenters", "cfp", "speaker", "replay",
    "Add a co-presenter to an editable proposal. Repeating the same participant returns the existing participant list.", "human"),
  operation("cfp.removeCoPresenter", "DELETE", "/api/events/:eventSlug/proposals/:proposalId/co-presenters/:presenterId", "cfp", "speaker", "safe",
    "Remove a co-presenter from an editable proposal.", "human"),
  operation("cfp.updateProposal", "PUT", "/api/events/:eventSlug/proposals/:proposalId", "cfp", "speaker", "safe",
    "Replace a proposal draft."),
  operation("cfp.submitProposal", "POST", "/api/events/:eventSlug/proposals/:proposalId/submit", "cfp", "speaker", "replay",
    "Submit a draft for review. Enforces the deadline and cannot be undone by the speaker.", "human"),

  // review
  operation("review.listReviewers", "GET", "/api/events/:eventSlug/cfp/reviewers", "review", "organizer", "safe",
    "Provisioned reviewers for the event."),
  operation("review.readPlan", "GET", "/api/events/:eventSlug/cfp/review-plan", "review", "organizer", "safe",
    "Active evaluation plan version and its weighted criteria."),
  operation("review.writePlan", "PUT", "/api/events/:eventSlug/cfp/review-plan", "review", "organizer", "safe",
    "Publish an evaluation plan. An unchanged plan reuses the active version; a change creates a new version.", "human"),
  operation("review.listRounds", "GET", "/api/events/:eventSlug/cfp/review-rounds", "review", "organizer", "safe",
    "List review rounds, their windows, and default blind setting."),
  operation("review.createRound", "POST", "/api/events/:eventSlug/cfp/review-rounds", "review", "organizer", "unsafe",
    "Create a review round. An uncertain retry may create another round.", "human"),
  operation("review.updateRound", "PATCH", "/api/events/:eventSlug/cfp/review-rounds/:roundId", "review", "organizer", "safe",
    "Update a review round using its expected update timestamp.", "human"),
  operation("review.readRoundPool", "GET", "/api/events/:eventSlug/cfp/review-rounds/:roundId/pool", "review", "organizer", "safe",
    "List the reviewers in one review round's assignment pool."),
  operation("review.replaceRoundPool", "PUT", "/api/events/:eventSlug/cfp/review-rounds/:roundId/pool", "review", "organizer", "safe",
    "Move the review-round pool toward the requested unique reviewer set and report members rejected by role or active-assignment constraints.", "human"),
  operation("review.autoAssignRound", "POST", "/api/events/:eventSlug/cfp/review-rounds/:roundId/assignments/auto", "review", "organizer", "safe",
    "Deterministically assign currently unassigned eligible proposals across the round pool within conflicts and capacity limits.", "human"),
  operation("review.reviewerProgress", "GET", "/api/events/:eventSlug/cfp/reviews/reviewer-progress", "review", "organizer", "safe",
    "Reviewer-level assignment, completion, and overdue counts, optionally for one round."),
  operation("review.queueReviewerReminder", "POST", "/api/events/:eventSlug/cfp/reviews/reminders", "review", "organizer", "idempotency-key",
    "Queue a reminder for a reviewer with pending assignments. `idempotencyKey` is a required body field.", "human", IDEMPOTENCY_BODY),
  operation("review.progress", "GET", "/api/events/:eventSlug/cfp/reviews/progress", "review", "organizer", "safe",
    "Review coverage and outstanding assignments."),
  operation("review.exportCsv", "GET", "/api/events/:eventSlug/cfp/reviews/export.csv", "review", "organizer", "safe",
    "Aggregate review results as CSV."),
  operation("review.assign", "POST", "/api/events/:eventSlug/cfp/proposals/:proposalId/assignments", "review", "organizer", "guarded",
    "Assign a reviewer to a proposal. Self-review is rejected."),
  operation("review.revokeAssignment", "POST", "/api/events/:eventSlug/cfp/assignments/:assignmentId/revoke", "review", "organizer", "safe",
    "Revoke a reviewer assignment. Scorecards already submitted are retained.", "human"),
  operation("review.readProposalReviews", "GET", "/api/events/:eventSlug/cfp/proposals/:proposalId/reviews", "review", "organizer", "safe",
    "Scorecards and aggregate score for one proposal."),
  operation("review.listOwnAssignments", "GET", "/api/events/:eventSlug/review/assignments", "review", "reviewer", "safe",
    "The signed-in reviewer's assignments."),
  operation("review.readOwnAssignment", "GET", "/api/events/:eventSlug/review/assignments/:assignmentId", "review", "reviewer", "safe",
    "One assignment, with the proposal and the criteria pinned to it."),
  operation("review.respondToInvitation", "POST", "/api/events/:eventSlug/review/assignments/:assignmentId/invitation", "review", "reviewer", "replay",
    "Accept or decline a review invitation."),
  operation("review.recuse", "POST", "/api/events/:eventSlug/review/assignments/:assignmentId/recuse", "review", "reviewer", "replay",
    "Recuse from an assignment."),
  operation("review.declareConflict", "POST", "/api/events/:eventSlug/review/assignments/:assignmentId/conflict", "review", "reviewer", "replay",
    "Declare a conflict of interest on an assignment."),
  operation("review.submitScorecard", "POST", "/api/events/:eventSlug/review/assignments/:assignmentId/review", "review", "reviewer", "replay",
    "Submit a scorecard against the criteria pinned to the assignment. Scorecards are immutable once written.", "human"),

  // decisions
  operation("decisions.list", "GET", "/api/events/:eventSlug/decisions", "decisions", "organizer", "safe",
    "Recorded decisions for the event."),
  operation("decisions.record", "POST", "/api/events/:eventSlug/decisions", "decisions", "organizer", "replay",
    "Accept or reject a proposal. Accepting materializes the speaker, session, onboarding tasks, and acceptance record. An identical repeat returns the existing decision; a changed decision or rationale answers 409.",
    "human"),
  operation("decisions.previewNotification", "GET", "/api/events/:eventSlug/decisions/:decisionId/notification-preview", "decisions", "organizer", "safe",
    "Render the notification for a decision without queueing it."),
  operation("decisions.queueNotification", "POST", "/api/events/:eventSlug/decisions/:decisionId/notification", "decisions", "organizer", "replay",
    "Save a notification snapshot to the outbox. Queued does not mean delivered; no transport is wired in this release.",
    "human"),
  operation("decisions.speakerWorkspace", "GET", "/api/events/:eventSlug/speaker/workspace", "decisions", "speaker", "safe",
    "The signed-in speaker's accepted sessions and outstanding obligations."),

  // communications
  operation("communications.history", "GET", "/api/events/:eventSlug/communications", "communications", "organizer", "safe",
    "Immutable communication history with truthful transport and delivery status."),
  operation("communications.queueSpeakerBulk", "POST", "/api/events/:eventSlug/communications/speakers/bulk", "communications", "organizer", "idempotency-key",
    "Queue an exact organizer-selected speaker message batch. `idempotencyKey` is a required body field and delivery remains unverified.", "human", IDEMPOTENCY_BODY),

  // speakers
  operation("speakers.contentWorkspace", "GET", "/api/events/:eventSlug/speaker/content-workspace", "speakers", "speaker", "safe",
    "The signed-in speaker's profile, tasks, deliverable requests, and upload history."),
  operation("speakers.updateOwnProfile", "PATCH", "/api/events/:eventSlug/speaker/profile", "speakers", "speaker", "safe",
    "Update the signed-in speaker's own profile."),
  operation("speakers.uploadOwnHeadshot", "POST", "/api/events/:eventSlug/speaker/headshot", "speakers", "speaker", "unsafe",
    "Upload the signed-in speaker's headshot as multipart form data."),
  operation("speakers.readOwnHeadshot", "GET", "/api/events/:eventSlug/speaker/headshot/file", "speakers", "speaker", "safe",
    "Download the signed-in speaker's headshot through an authorization-checked route."),
  operation("speakers.updateOwnTask", "PATCH", "/api/events/:eventSlug/speaker/tasks/:taskId", "speakers", "speaker", "safe",
    "Update one of the signed-in speaker's onboarding tasks."),
  operation("speakers.uploadDeliverable", "POST", "/api/events/:eventSlug/speaker/deliverables/:requestId/versions", "speakers", "speaker", "idempotency-key",
    "Upload a new deliverable version as multipart form data. The Idempotency-Key header is required and must be 8 to 128 characters; a retry reusing it returns the existing version instead of creating a second one.",
    "none", IDEMPOTENCY_HEADER),
  operation("speakers.readOwnDeliverable", "GET", "/api/events/:eventSlug/speaker/deliverables/:versionId/file", "speakers", "speaker", "safe",
    "Download one of the signed-in speaker's deliverable versions."),
  operation("speakers.commentOnOwnSession", "POST", "/api/events/:eventSlug/speaker/sessions/:sessionId/comments", "speakers", "speaker", "unsafe",
    "Add a speaker comment to a session thread."),
  operation("speakers.listRoster", "GET", "/api/events/:eventSlug/speakers", "speakers", "organizer", "safe",
    "Speaker roster for the event."),
  operation("speakers.createRosterProfile", "POST", "/api/events/:eventSlug/speakers", "speakers", "organizer", "unsafe",
    "Create an unclaimed roster profile. It sends no invitation and cannot sign in."),
  operation("speakers.importRoster", "POST", "/api/events/:eventSlug/speakers/import", "speakers", "organizer", "unsafe",
    "Bulk-import roster profiles from CSV. Creates unclaimed profiles only.", "human"),
  operation("speakers.communicationTemplates", "GET", "/api/events/:eventSlug/speakers/communications/templates", "speakers", "organizer", "safe",
    "Available reminder templates."),
  operation("speakers.queueReminders", "POST", "/api/events/:eventSlug/speakers/communications/reminders", "speakers", "organizer", "idempotency-key",
    "Queue a speaker reminder to the outbox. `idempotencyKey` is a required body field; reusing it with different content answers 409.",
    "human", IDEMPOTENCY_BODY),
  operation("speakers.updateRosterTask", "PATCH", "/api/events/:eventSlug/speakers/:speakerId/tasks/:taskId", "speakers", "organizer", "safe",
    "Update an onboarding task on a roster profile."),
  operation("speakers.createRosterTask", "POST", "/api/events/:eventSlug/speakers/tasks", "speakers", "organizer", "unsafe",
    "Add an onboarding task to one or more speakers."),
  operation("speakers.updateRosterProfile", "PATCH", "/api/events/:eventSlug/speakers/:speakerId/profile", "speakers", "organizer", "safe",
    "Update a roster profile as an organizer."),
  operation("speakers.setVisibility", "PATCH", "/api/events/:eventSlug/speakers/:speakerId/visibility", "speakers", "organizer", "safe",
    "Change whether a speaker appears in public output.", "human"),
  operation("speakers.setWorkflowState", "PATCH", "/api/events/:eventSlug/speakers/:speakerId/workflow", "speakers", "organizer", "safe",
    "Move a roster profile through its organizer workflow state."),
  operation("speakers.uploadRosterHeadshot", "POST", "/api/events/:eventSlug/speakers/:speakerId/headshot", "speakers", "organizer", "unsafe",
    "Upload a headshot on behalf of a roster profile."),
  operation("speakers.readRosterHeadshot", "GET", "/api/events/:eventSlug/speakers/:speakerId/headshot/file", "speakers", "organizer", "safe",
    "Download a roster profile's headshot."),
  operation("speakers.restoreProfileVersion", "POST", "/api/events/:eventSlug/speakers/:speakerId/history/:historyId/restore", "speakers", "organizer", "unsafe",
    "Restore an earlier version of a roster profile over the current one.", "human"),
  operation("speakers.listContent", "GET", "/api/events/:eventSlug/content", "speakers", "organizer", "safe",
    "Session content, deliverable state, and approval status across the event."),
  operation("speakers.exportDeliverables", "GET", "/api/events/:eventSlug/content/deliverables.zip", "speakers", "organizer", "safe",
    "Download current approved deliverables as a ZIP archive."),
  operation("speakers.readDeliverableFile", "GET", "/api/events/:eventSlug/content/deliverables/:versionId/file", "speakers", "organizer", "safe",
    "Download one deliverable version."),
  operation("speakers.setContentApproval", "PATCH", "/api/events/:eventSlug/content/:sessionId/approval", "speakers", "organizer", "safe",
    "Approve or unapprove session content. Public output requires approval.", "human"),
  operation("speakers.requestDeliverable", "POST", "/api/events/:eventSlug/content/:sessionId/requests", "speakers", "organizer", "unsafe",
    "Ask a speaker for a deliverable."),
  operation("speakers.updateDeliverableRequest", "PATCH", "/api/events/:eventSlug/content/:sessionId/requests/:requestId", "speakers", "organizer", "safe",
    "Update an existing deliverable request."),
  operation("speakers.reviewDeliverable", "POST", "/api/events/:eventSlug/content/:sessionId/reviews", "speakers", "organizer", "idempotency-key",
    "Record a review verdict on a deliverable version. `idempotencyKey` is a required body field, deduplicated per version, and the request must carry the expected session revision.",
    "none", IDEMPOTENCY_BODY),
  operation("speakers.commentOnSession", "POST", "/api/events/:eventSlug/content/:sessionId/comments", "speakers", "organizer", "unsafe",
    "Add an organizer comment to a session thread."),
  operation("speakers.updateSessionContent", "PATCH", "/api/events/:eventSlug/content/:sessionId", "speakers", "organizer", "safe",
    "Edit session content as an organizer. Edits are versioned."),
  operation("speakers.restoreSessionVersion", "POST", "/api/events/:eventSlug/content/:sessionId/history/:historyId/restore", "speakers", "organizer", "unsafe",
    "Restore an earlier version of session content over the current one.", "human"),

  // agenda
  operation("agenda.read", "GET", "/api/events/:eventSlug/agenda", "agenda", "organizer", "safe",
    "Days, rooms, tracks, placements, and current conflict diagnostics."),
  operation("agenda.createRoom", "POST", "/api/events/:eventSlug/agenda/rooms", "agenda", "organizer", "unsafe",
    "Add a room."),
  operation("agenda.updateRoom", "PATCH", "/api/events/:eventSlug/agenda/rooms/:roomId", "agenda", "organizer", "safe",
    "Update a room."),
  operation("agenda.createTrack", "POST", "/api/events/:eventSlug/agenda/tracks", "agenda", "organizer", "unsafe",
    "Add a track."),
  operation("agenda.updateTrack", "PATCH", "/api/events/:eventSlug/agenda/tracks/:trackId", "agenda", "organizer", "safe",
    "Update a track."),
  operation("agenda.createDay", "POST", "/api/events/:eventSlug/agenda/days", "agenda", "organizer", "unsafe",
    "Add a schedule day."),
  operation("agenda.updateDay", "PATCH", "/api/events/:eventSlug/agenda/days/:dayId", "agenda", "organizer", "safe",
    "Update a schedule day."),
  operation("agenda.createPlacement", "POST", "/api/events/:eventSlug/agenda/placements", "agenda", "organizer", "guarded",
    "Place a session in a room and time slot. A room overlap is rejected."),
  operation("agenda.updatePlacement", "PATCH", "/api/events/:eventSlug/agenda/placements/:placementId", "agenda", "organizer", "safe",
    "Move an existing placement."),
  operation("agenda.deletePlacement", "DELETE", "/api/events/:eventSlug/agenda/placements/:placementId", "agenda", "organizer", "safe",
    "Remove a placement from the schedule."),
  operation("agenda.autoPlace", "POST", "/api/events/:eventSlug/agenda/auto-place", "agenda", "organizer", "safe",
    "Deterministic conflict-avoiding auto-fill of unplaced sessions. Same inputs produce the same schedule."),
  operation("agenda.publish", "POST", "/api/events/:eventSlug/agenda/publish", "agenda", "organizer", "safe",
    "Publish the agenda. Rejected while any conflict is outstanding, or when nothing is placed. A repeat publishes only what is newly eligible. This makes the program public.",
    "human"),

  // publication
  operation("publication.program", "GET", "/api/program", "publication", "anonymous", "safe",
    "Published program as JSON. Takes `?event=<slug>`."),
  operation("publication.speakers", "GET", "/api/program/speakers", "publication", "anonymous", "safe",
    "Published speaker profiles as JSON. Takes `?event=<slug>`."),
  operation("publication.publicEmbed", "GET", "/api/public/events/:eventSlug/embeds/:embedSlug", "publication", "anonymous", "safe",
    "Saved embed configuration rendered for anonymous consumers."),
  operation("publication.publicEmbedCalendar", "GET", "/api/public/events/:eventSlug/embeds/:embedSlug/calendar.ics", "publication", "anonymous", "safe",
    "iCalendar feed for the approved, scheduled sessions selected by a public embed."),
  operation("publication.publicHeadshot", "GET", "/api/public/events/:eventSlug/speakers/:speakerSlug/headshot", "publication", "anonymous", "safe",
    "Headshot for a speaker on the published program."),
  operation("publication.calendarFeed", "GET", "/api/program.ics", "publication:calendar", "anonymous", "safe",
    "Whole published program as iCalendar with stable event identities. Takes `?event=<slug>`."),
  operation("publication.calendarSelection", "POST", "/api/program.ics", "publication:calendar", "anonymous", "safe",
    "iCalendar for an attendee-selected subset. Bounded to 100 sessions carried in the request body."),
  operation("publication.listEmbeds", "GET", "/api/events/:eventSlug/embeds", "publication:embeds", "organizer", "safe",
    "Saved embed configurations for the event."),
  operation("publication.createEmbed", "POST", "/api/events/:eventSlug/embeds", "publication:embeds", "organizer", "guarded",
    "Save an embed configuration. This creates a public surface.", "human"),
  operation("publication.updateEmbed", "PATCH", "/api/events/:eventSlug/embeds/:embedId", "publication:embeds", "organizer", "safe",
    "Update a saved embed configuration. Revision-guarded.", "human"),

  // agent + discovery
  operation("agent.manifest", "GET", "/api/agent/manifest", "agent", "anonymous", "safe",
    "This document. The authenticated surface of this instance, described for agents."),
  operation("discovery.llmsTxt", "GET", "/llms.txt", "discovery", "anonymous", "safe",
    "Anonymous read-only index of this instance for AI agents and crawlers."),
] as const;

/**
 * What a caller must send on every mutation.
 *
 * `requireSameOriginMutation` rejects any non-GET/HEAD/OPTIONS `/api` request
 * that does not carry these. A browser sends the first two automatically and the
 * SPA adds the marker; a non-browser agent must set them itself, and gets an
 * otherwise unexplained 403 if it does not.
 */
export function mutationPreamble(origin: string) {
  return {
    appliesTo: "Every /api request whose method is not GET, HEAD, or OPTIONS.",
    headers: {
      origin,
      "x-confpilot-request": "1",
    },
    notes: [
      "The Origin value is the exact origin of this instance and matches the request URL.",
      "Send Sec-Fetch-Site only as `same-origin`, or omit it. Any other value is rejected.",
      "A missing or mismatched header answers 403 UNSAFE_REQUEST_REJECTED.",
      "Multipart uploads use the same preamble; do not set Content-Type manually for them.",
    ],
  } as const;
}

/** Rules a correct agent integration has to respect, stated once. */
export const agentBoundaries = [
  "Every query and mutation is scoped by event and role. A session that lacks the role answers 403 rather than filtering results.",
  "Unpublished sessions, speaker contact details, uploaded files, and review data are never available anonymously.",
  "Operations marked `approval: human` publish, notify, decide a person's proposal, or write an immutable record. Confirm with a human before calling them.",
  "Queueing a notification is not delivery. No email transport is wired in this release.",
  "An organizer-created roster profile is unclaimed: it sends no invitation and cannot sign in.",
  "Scorecards are pinned to the assignment's evaluation plan version and cannot be edited after submission.",
] as const;

export const retryModeDescriptions: Readonly<Record<RetryMode, string>> = {
  safe: "Repeating with the same input has no additional effect.",
  replay: "Repeating an identical request returns the existing record; a changed one is rejected with 409.",
  guarded: "A duplicate cannot be created, but a repeat answers 409 rather than returning the record.",
  "idempotency-key": "Send the key at the operation's declared idempotency location (a header or required JSON body field) so a repeat is treated as the same write.",
  unsafe: "A repeat may create a duplicate. Read current state back before retrying.",
};
