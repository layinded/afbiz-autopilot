/**
 * Meta WhatsApp Cloud API webhook payload shapes (Cloud API webhooks, "messages" field).
 * Lifted from the proven afcloud-business agent channel (platform seams removed).
 */

export interface WhatsAppText {
  body: string;
}

export interface WhatsAppButtonReply {
  id: string;
  title: string;
}

export interface WhatsAppInteractive {
  type: "button_reply" | "list_reply";
  button_reply?: WhatsAppButtonReply;
  list_reply?: WhatsAppButtonReply;
}

export interface WhatsAppInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: WhatsAppText;
  interactive?: WhatsAppInteractive;
  image?: unknown;
  audio?: unknown;
  video?: unknown;
  document?: unknown;
  location?: unknown;
  contacts?: unknown;
  sticker?: unknown;
  reaction?: unknown;
}

export interface WhatsAppStatusMessage {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title: string; message?: string }[];
}

export interface WhatsAppContact {
  profile?: { name?: string };
  wa_id: string;
}

export interface WhatsAppValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppInboundMessage[];
  statuses?: WhatsAppStatusMessage[];
}

export interface WhatsAppChange {
  value: WhatsAppValue;
  field: string;
}

export interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppWebhookBody {
  object?: string;
  entry?: WhatsAppEntry[];
}

export interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

export interface InboundTextMessage {
  kind: "text";
  waMessageId: string;
  from: string;
  text: string;
}

export interface InboundButtonMessage {
  kind: "button";
  waMessageId: string;
  from: string;
  buttonId: string;
  buttonTitle: string;
}

export interface InboundUnsupportedMessage {
  kind: "unsupported";
  waMessageId: string;
  from: string;
  type: string;
}

export type ParsedInboundMessage = InboundTextMessage | InboundButtonMessage | InboundUnsupportedMessage;

export type ParsedStatus = { kind: "status"; waMessageId: string; status: string; from: string };

export type ParsedWebhookEvent =
  | { kind: "message"; phoneNumberId: string; message: ParsedInboundMessage; profileName?: string }
  | { kind: "status"; status: ParsedStatus }
  | { kind: "ignored" };
