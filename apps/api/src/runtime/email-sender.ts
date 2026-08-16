/** A private message snapshot ready for a delivery adapter. */
export interface OutboundEmail {
  outboxId: string;
  to: string;
  subject: string;
  text: string;
}

export type EmailResult =
  | { ok: true; provider: string; providerMessageId: string | null }
  | { ok: false; provider: string | null; code: string; retryable: boolean };

/** Runtime port implemented by each host. It must never log message fields. */
export interface EmailSender {
  send(message: OutboundEmail): Promise<EmailResult>;
}

/**
 * The mail binding itself, as the surface this application actually uses.
 *
 * `Env.EMAIL` was the last binding still typed by its Cloudflare global. That was
 * harmless while Cloudflare was the only host: `SendEmail` is an ambient type, so
 * naming it costs nothing until something has to compile without Workers types —
 * and then it costs everything, because it drags the whole application into a
 * project that cannot see it.
 *
 * Cloudflare's binding satisfies this structurally, so the adapter is unchanged
 * and no call site moves. `test/private-file-store-contract.test.ts` asserts that
 * at compile time, in the project that does have Workers types, so this narrower
 * type cannot drift away from the real one unnoticed.
 */
export interface EmailBindingAddress {
  name: string;
  email: string;
}

export interface EmailBindingMessage {
  to: string | EmailBindingAddress | (string | EmailBindingAddress)[];
  from: string | EmailBindingAddress;
  subject: string;
  html?: string;
  text?: string;
}

export interface EmailBinding {
  send(message: EmailBindingMessage): Promise<{ messageId: string }>;
}

export type EmailCapability =
  | { enabled: true; provider: string; reason: "configured"; sendAfter: string }
  | {
    enabled: false;
    provider: null;
    reason: "delivery_disabled" | "sender_missing" | "sender_invalid" | "activation_cutoff_missing";
  };

/** Capability and adapter must travel together so disabled delivery cannot drain the outbox. */
export interface EmailDeliveryRuntime {
  capability: EmailCapability;
  sender: EmailSender;
}

export function createDisabledEmailSender(
  reason: Exclude<EmailCapability["reason"], "configured"> = "delivery_disabled",
): EmailDeliveryRuntime {
  return {
    capability: { enabled: false, provider: null, reason } satisfies EmailCapability,
    sender: {
      async send(): Promise<EmailResult> {
        return { ok: false, provider: null, code: "EMAIL_NOT_CONFIGURED", retryable: false };
      },
    } satisfies EmailSender,
  };
}
