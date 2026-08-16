# Messaging architecture

ConfPilot records outbound transactional-message intent separately from delivery.
The generic `message_outbox` is private, event-scoped, deduplicated, retryable,
and provider-neutral. Feature code enqueues a versioned template snapshot; a host
adapter drains it later. Request handlers must not call a mail provider directly.

The repository ships with delivery disabled. There is no default sender address,
API token, remote development binding, or hosted ConfPilot domain in source. An
operator must configure an adapter, a verified sender, and an explicit
`EMAIL_DELIVERY_SEND_AFTER` UTC activation cutoff before messaging is reported
as enabled. Only snapshots created at or after that cutoff are eligible, so
enabling delivery cannot unexpectedly drain a historical disabled-period or
backfill backlog. Missing or invalid configuration returns a typed failure; the
dispatcher refuses to lease or consume queued messages when that capability is
disabled.

Cloudflare-hosted instances can inject a `SendEmail` binding into the Cloudflare
adapter. Other runtimes should implement the small `EmailSender` port—for example,
with SMTP or an HTTP transactional-email provider—without changing feature code.
Run the same adapter contract tests against every implementation.

Privacy rules:

- Never log recipients, subjects, message bodies, or provider errors that may echo them.
- Persist only private delivery records; expose status through authenticated,
  event-scoped APIs when a feature needs it.
- Store a content hash for dedupe/audit and keep the delivery snapshot immutable.
- Store only a sanitized provider error code, not the provider error message.
- Keep templates deterministic and versioned. Template rendering does not use AI
  or the network. A future operator override must preserve those properties.

## Speaker reminders

The organizer speaker workspace exposes two revisioned templates: a complete
readiness reminder and an open-task reminder. The API renders either template
from the selected speaker's current event-scoped profile, task, session, and
deliverable records. It accepts no free-form subject or body and performs no AI
or network work.

Each request targets one speaker and carries an idempotency key. ConfPilot hashes
the speaker, template, and key into an event-scoped outbox dedupe key. Replaying
the same request returns the same immutable row; reusing the key after canonical
reminder content changes fails with a conflict and requires a new key. Unlinked
roster profiles, missing same-event speaker membership, declined speakers,
missing contact addresses, cross-event speaker IDs, and templates with no
outstanding items fail closed without creating a row.
The outbox stores the creating organizer's user ID, and its insert trigger
re-checks same-event organizer membership atomically with the enqueue. A stale
route authorization or direct service call therefore cannot create a reminder
after that role is revoked.

Queueing a reminder is not sending it. The organizer response maps the internal
terminal state to `provider_accepted`, and the UI explicitly avoids an inbox
delivery claim. Dispatch still belongs to the separately configured host
adapter, and an absent or invalid sender or activation cutoff remains unable to
lease or consume the queued row.

Delivery semantics are intentionally at-least-once. Every lease has an opaque
owner token, and a stale worker cannot record success, retry, or failure after it
loses that lease. Expired leases re-enter the queue with exponential backoff.
However, no database outbox can prove that an external provider did not accept a
message before a timeout; a rare duplicate remains possible after an ambiguous
provider result. Adapters should pass `outboxId` as an idempotency key whenever
their provider supports one, and message content should be safe to receive twice.

The older decision-specific `notification_outbox` remains the immutable source
for decision-notification intent and the organizer who authorized it. The host
dispatcher bridges eligible pending snapshots idempotently into
`message_outbox`, where a system actor performs delivery and synchronizes the
legacy row to a terminal provider-accepted or failed state. A bad legacy row is
failed with a sanitized code without preventing unrelated messages from being
dispatched.

Generic messages contain personal data. Before enabling delivery, an operator
must define a retention and erasure policy appropriate to their deployment. The
bounded `purgeTerminalMessages` primitive can remove delivered, failed, or
canceled rows older than a host-selected cutoff; rows that are neither terminal
nor canceled, plus every active provider lease, remain protected. This foundation exposes no outbox or purge route
and adds no automated schedule that could silently destroy delivery history.

The Worker schedule runs every five minutes but is a no-op while delivery is
disabled. An enabled instance processes at most 25 messages per tick (300/hour
globally). Decision notices and reviewer and speaker reminders are ordered ahead
of bulk speaker messages; there is no per-event round-robin fairness guarantee.
Operators must verify the Cloudflare Email binding permits the intended external
recipient addresses before enabling the flag. Provider acceptance is not inbox
delivery proof. A provider daily-quota response leaves the message queued,
preserves its code in `lastErrorCode`, and does not consume terminal retry budget.
