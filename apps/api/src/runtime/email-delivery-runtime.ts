import { createCloudflareEmailSender } from "./cloudflare-email-sender";
import { createDisabledEmailSender, type EmailBinding, type EmailDeliveryRuntime } from "./email-sender";

export interface EmailRuntimeEnvironment {
  EMAIL?: EmailBinding;
  EMAIL_DELIVERY_ENABLED?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_DELIVERY_SEND_AFTER?: string;
}

const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function isCanonicalUtcSeconds(value: string) {
  if (!UTC_SECONDS.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().replace(".000Z", "Z") === value;
}

/**
 * Resolve the host adapter only behind an explicit opt-in. A present binding is
 * not authorization to drain the outbox, and malformed truthy values fail closed.
 */
export function resolveEmailDeliveryRuntime(environment: EmailRuntimeEnvironment): EmailDeliveryRuntime {
  const enabled = environment.EMAIL_DELIVERY_ENABLED?.trim().toLowerCase();
  if (enabled === undefined || enabled === "" || enabled === "false") {
    return createDisabledEmailSender("delivery_disabled");
  }
  if (enabled !== "true") return createDisabledEmailSender("sender_invalid");
  const sendAfter = environment.EMAIL_DELIVERY_SEND_AFTER?.trim() ?? "";
  if (!isCanonicalUtcSeconds(sendAfter)) {
    return createDisabledEmailSender("activation_cutoff_missing");
  }
  return createCloudflareEmailSender(environment.EMAIL, {
    fromAddress: environment.EMAIL_FROM_ADDRESS ?? "",
    fromName: environment.EMAIL_FROM_NAME ?? "",
    sendAfter,
  });
}
