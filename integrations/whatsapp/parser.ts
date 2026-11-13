/**
 * Meta Cloud API webhook payload parsing into normalized events:
 * text messages (the only type the MVP agent handles), other message types
 * (receipt claimed, no agent work), and delivery/read statuses (ignored).
 */
export interface InboundTextMessage {
  kind: "text";
  from: string;
  waMessageId: string;
  text: string;
  profileName?: string;
}

export interface InboundOtherMessage {
  kind: "other";
  from: string;
  waMessageId: string;
}

export type WebhookEvent =
  | { kind: "message"; message: InboundTextMessage | InboundOtherMessage }
  | { kind: "status"; waMessageId: string; status: string }
  | { kind: "ignored" };

export function parseWebhookBodyJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseWebhookEvents(body: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const root = body as { entry?: unknown } | null;
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    const changeList = Array.isArray(changes) ? changes : [];
    for (const change of changeList) {
      const value = (change as { value?: unknown }).value as
        | { messages?: unknown; statuses?: unknown; contacts?: unknown }
        | undefined;
      if (!value) {
        events.push({ kind: "ignored" });
        continue;
      }
      const profileName = Array.isArray(value.contacts)
        ? ((value.contacts as { profile?: { name?: string } }[])[0]?.profile?.name ?? undefined)
        : undefined;
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const raw of messages as { id?: string; from?: string; type?: string; text?: { body?: string } }[]) {
        if (!raw.id || !raw.from) {
          events.push({ kind: "ignored" });
          continue;
        }
        if (raw.type === "text" && typeof raw.text?.body === "string") {
          events.push({
            kind: "message",
            message: { kind: "text", from: raw.from, waMessageId: raw.id, text: raw.text.body, ...(profileName ? { profileName } : {}) },
          });
        } else {
          events.push({ kind: "message", message: { kind: "other", from: raw.from, waMessageId: raw.id } });
        }
      }
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const raw of statuses as { id?: string; status?: string }[]) {
        if (!raw.id || !raw.status) {
          events.push({ kind: "ignored" });
          continue;
        }
        events.push({ kind: "status", waMessageId: raw.id, status: raw.status });
      }
    }
  }
  if (events.length === 0) events.push({ kind: "ignored" });
  return events;
}
