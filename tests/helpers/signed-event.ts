/** Builds Meta-shaped webhook payloads and signs them the way Meta does. */
import { createHmac } from "node:crypto";

export interface TextEventSpec {
  from?: string;
  text: string;
  id?: string;
}

export function textEventPayload(spec: TextEventSpec): Record<string, unknown> {
  const waId = (spec.from ?? "+2349000000001").replace(/^\+/, "");
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "TEST_BUSINESS_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "2349000000000", phone_number_id: "TEST_PHONE_ID" },
              contacts: [{ profile: { name: "Test Sender" }, wa_id: waId }],
              messages: [
                {
                  from: waId,
                  id: spec.id ?? `wamid.test_${Math.random().toString(36).slice(2)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  text: { body: spec.text },
                  type: "text",
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function statusEventPayload(waMessageId: string, status: string): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "TEST_BUSINESS_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "2349000000000", phone_number_id: "TEST_PHONE_ID" },
              statuses: [{ id: waMessageId, status, timestamp: String(Math.floor(Date.now() / 1000)) }],
            },
          },
        ],
      },
    ],
  };
}

export function otherMessagePayload(waMessageId: string): Record<string, unknown> {
  const base = textEventPayload({ text: "x" }) as Record<string, unknown>;
  const entry = (base["entry"] as Record<string, unknown>[])[0]!;
  const value = ((entry["changes"] as Record<string, unknown>[])[0]!["value"] as Record<string, unknown>)!;
  value["messages"] = [
    { from: "2349000000001", id: waMessageId, timestamp: "1699999999", type: "image", image: { id: "img1" } },
  ];
  return base;
}

export function encodeAndSign(
  appSecret: string,
  payload: unknown,
): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", appSecret)
    .update(new Uint8Array(Buffer.from(rawBody, "utf8")))
    .digest("hex")}`;
  return {
    rawBody,
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
  };
}
