import type { EmailBinding, EmailDeliveryRuntime, EmailResult } from "./email-sender";

export interface CloudflareEmailSenderConfig {
  fromAddress: string;
  fromName: string;
  sendAfter: string;
}

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RETRYABLE_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DELIVERY_FAILED",
  "E_INTERNAL_SERVER_ERROR",
  "E_DAILY_LIMIT_EXCEEDED",
]);

function isCanonicalUtcSeconds(value: string) {
  if (!UTC_SECONDS.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().replace(".000Z", "Z") === value;
}

function providerCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return "E_PROVIDER_FAILURE";
  const code = String(error.code);
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "E_PROVIDER_FAILURE";
}

function htmlBody(text: string) {
  const escaped = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  return escaped.split("\n\n")
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("");
}

/**
 * Hosted Workers adapter. The binding and sender are deliberately injected:
 * the generic self-host configuration has neither and therefore cannot send.
 */
export function createCloudflareEmailSender(
  binding: EmailBinding | undefined,
  config: CloudflareEmailSenderConfig | undefined,
): EmailDeliveryRuntime {
  if (!binding) {
    return {
      capability: { enabled: false, provider: null, reason: "sender_missing" },
      sender: { async send() { return { ok: false, provider: null, code: "EMAIL_NOT_CONFIGURED", retryable: false }; } },
    };
  }
  const sendAfter = typeof config?.sendAfter === "string" ? config.sendAfter.trim() : "";
  if (!isCanonicalUtcSeconds(sendAfter)) {
    return {
      capability: { enabled: false, provider: null, reason: "activation_cutoff_missing" },
      sender: { async send() { return { ok: false, provider: null, code: "EMAIL_NOT_CONFIGURED", retryable: false }; } },
    };
  }
  const fromAddress = typeof config?.fromAddress === "string" ? config.fromAddress.trim().toLowerCase() : "";
  const fromName = typeof config?.fromName === "string" ? config.fromName.trim() : "";
  if (!EMAIL_ADDRESS.test(fromAddress) || fromName.length < 1 || fromName.length > 120) {
    return {
      capability: { enabled: false, provider: null, reason: "sender_invalid" },
      sender: { async send() { return { ok: false, provider: null, code: "EMAIL_SENDER_INVALID", retryable: false }; } },
    };
  }
  return {
    capability: {
      enabled: true,
      provider: "cloudflare-email",
      reason: "configured",
      sendAfter,
    },
    sender: {
      async send(message): Promise<EmailResult> {
        try {
          const result = await binding.send({
            to: message.to,
            from: { email: fromAddress, name: fromName },
            subject: message.subject,
            html: htmlBody(message.text),
            text: message.text,
          });
          return { ok: true, provider: "cloudflare-email", providerMessageId: result.messageId };
        } catch (error) {
          const code = providerCode(error);
          return { ok: false, provider: "cloudflare-email", code, retryable: RETRYABLE_CODES.has(code) };
        }
      },
    },
  };
}
