/** Webhook body splitting: messages / interactive replies / statuses / unsupported.
 *  Lifted from the proven afcloud-business agent channel. */
import type {
  ParsedInboundMessage,
  ParsedStatus,
  ParsedWebhookEvent,
  WhatsAppWebhookBody,
} from "./types.js";

export function parseWebhookEvents(body: WhatsAppWebhookBody): ParsedWebhookEvent[] {
  const events: ParsedWebhookEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const profileNames = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (typeof contact.wa_id === "string" && contact.profile?.name) {
          profileNames.set(contact.wa_id, contact.profile.name);
        }
      }
      for (const message of value.messages ?? []) {
        events.push({
          kind: "message",
          phoneNumberId: value.metadata?.phone_number_id ?? "",
          message: parseMessage(message),
          profileName: profileNames.get(message.from),
        });
      }
      for (const status of value.statuses ?? []) {
        // Unattributable statuses (no recipient) are transport noise — not claimable.
        const from = typeof status.recipient_id === "string" ? status.recipient_id : "";
        if (!from) continue;
        const parsed: ParsedStatus = { kind: "status", waMessageId: status.id, status: status.status, from };
        events.push({ kind: "status", status: parsed });
      }
    }
  }
  if (events.length === 0) events.push({ kind: "ignored" });
  return events;
}

function parseMessage(message: {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}): ParsedInboundMessage {
  if (message.type === "text" && typeof message.text?.body === "string") {
    return { kind: "text", waMessageId: message.id, from: message.from, text: message.text.body };
  }
  if (message.type === "interactive") {
    const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
    if (reply && typeof reply.id === "string") {
      return {
        kind: "button",
        waMessageId: message.id,
        from: message.from,
        buttonId: reply.id,
        buttonTitle: reply.title ?? "",
      };
    }
  }
  return { kind: "unsupported", waMessageId: message.id, from: message.from, type: message.type ?? "unknown" };
}

export function parseWebhookBodyJson(text: string): WhatsAppWebhookBody {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "entry" in (parsed as Record<string, unknown>)) {
      return parsed as WhatsAppWebhookBody;
    }
  } catch {
    // fallthrough
  }
  return {};
}
