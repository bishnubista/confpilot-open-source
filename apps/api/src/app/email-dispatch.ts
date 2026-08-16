import {
  dispatchQueuedMessages,
  enqueueMessage,
  MessageDedupeConflictError,
} from "../features/messaging/message-outbox";
import { resolveEmailDeliveryRuntime } from "../runtime/email-delivery-runtime";
import type { Env } from "../types";
import type { Database } from "../runtime/database";

interface PendingDecisionNotification {
  id: string;
  eventId: string;
  queuedByUserId: string;
  recipientEmail: string | null;
  recipientName: string;
  subject: string;
  body: string;
  queuedAt: string;
}

interface BridgedMessageState {
  state: "queued" | "leased" | "delivered" | "failed";
  deliveredAt: string | null;
  lastErrorCode: string | null;
}

function scheduledTimestamp(value: number) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function decisionMessageIdentity(notificationId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(notificationId));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `decision-notification:${hash}`;
}

async function failDecisionNotification(database: Database, id: string, code: string) {
  await database.prepare(`UPDATE notification_outbox
    SET state = 'failed', sent_at = NULL, failure_message = ?
    WHERE id = ? AND state = 'pending'`)
    .bind(`Notification could not be prepared for provider dispatch (${code}).`, id).run();
}

async function bridgePendingDecisionNotifications(database: Database, limit: number, sendAfter: string) {
  const pending = await database.prepare(`SELECT id, event_id AS eventId,
      queued_by_user_id AS queuedByUserId, recipient_email AS recipientEmail,
      recipient_name AS recipientName, subject, body, queued_at AS queuedAt
    FROM notification_outbox
    WHERE state = 'pending' AND queued_at >= ?
    ORDER BY queued_at, id
    LIMIT ?`).bind(sendAfter, limit).all<PendingDecisionNotification>();

  const bridged: PendingDecisionNotification[] = [];
  let failed = 0;
  for (const notification of pending.results) {
    if (!notification.recipientEmail) {
      await failDecisionNotification(database, notification.id, "RECIPIENT_UNAVAILABLE");
      failed += 1;
      continue;
    }
    try {
      const identity = await decisionMessageIdentity(notification.id);
      await enqueueMessage(database, {
        id: identity,
        eventId: notification.eventId,
        // The legacy row permanently records the organizer who authorized this
        // snapshot. The host bridge is a system action and must not be poisoned
        // if that organizer's membership changes before a scheduled run.
        dedupeKey: identity,
        intent: "decision_notification",
        recipientEmail: notification.recipientEmail,
        recipientName: notification.recipientName,
        templateKey: "decision.notification",
        templateRevision: 1,
        subject: notification.subject,
        text: notification.body,
        now: notification.queuedAt,
      });
      bridged.push(notification);
    } catch (error) {
      if (error instanceof MessageDedupeConflictError) {
        bridged.push(notification);
        continue;
      }
      if (!(error instanceof TypeError)) throw error;
      await failDecisionNotification(database, notification.id, "INVALID_SNAPSHOT");
      failed += 1;
    }
  }

  return { notifications: bridged, summary: { bridged: bridged.length, failed } };
}

async function synchronizeDecisionNotification(
  database: Database,
  notification: PendingDecisionNotification,
) {
  const identity = await decisionMessageIdentity(notification.id);
  const message = await database.prepare(`SELECT state, delivered_at AS deliveredAt,
      last_error_code AS lastErrorCode
    FROM message_outbox
    WHERE event_id = ? AND dedupe_key = ?
    LIMIT 1`).bind(notification.eventId, identity).first<BridgedMessageState>();
  if (message?.state === "delivered") {
    await database.prepare(`UPDATE notification_outbox
      SET state = 'sent', sent_at = ?, failure_message = NULL
      WHERE id = ? AND state = 'pending'`).bind(message.deliveredAt, notification.id).run();
  } else if (message?.state === "failed") {
    const code = message.lastErrorCode ?? "PROVIDER_FAILURE";
    await database.prepare(`UPDATE notification_outbox
      SET state = 'failed', sent_at = NULL, failure_message = ?
      WHERE id = ? AND state = 'pending'`)
      .bind(`Provider dispatch failed (${code}).`, notification.id).run();
  }
}

export async function runScheduledEmailDispatch(environment: Env, scheduledTime: number) {
  const runtime = resolveEmailDeliveryRuntime(environment);
  if (!runtime.capability.enabled) {
    return { status: "disabled" as const, reason: runtime.capability.reason };
  }
  const bridge = await bridgePendingDecisionNotifications(
    environment.DB,
    25,
    runtime.capability.sendAfter,
  );
  const summary = await dispatchQueuedMessages(environment.DB, runtime, {
    now: scheduledTimestamp(scheduledTime),
    limit: 25,
  });
  for (const notification of bridge.notifications) {
    await synchronizeDecisionNotification(environment.DB, notification);
  }
  return {
    status: "dispatched" as const,
    bridge: bridge.summary,
    summary,
  };
}
