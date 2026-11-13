/**
 * Meta Cloud API webhook surface, mounted on the official VoltAgent server
 * (honoServer configureApp), following the proven afcloud channel shape:
 *
 *   GET  /webhook/whatsapp  — hub.mode/hub.verify_token/hub.challenge handshake
 *   POST /webhook/whatsapp  — signed event receiver (verify-before-parse,
 *                             fast ACK, async processing, per-sender serialized)
 *
 * Duplicate-message protection: every message id is claimed against a
 * PostgreSQL receipt table before any agent work happens. Messages for a
 * different phone_number_id than the configured instance are ignored.
 */
import type { Context } from "hono";
import { parseWebhookBodyJson, parseWebhookEvents } from "./parser.js";
import { signatureValid, verifyTokenMatch } from "./security.js";
import { logger } from "../../lib/config.js";

export interface RouteMount {
  get(path: string, handler: (c: Context) => unknown): unknown;
  post(path: string, handler: (c: Context) => unknown): unknown;
}

export interface WebhookDeps {
  verifyToken: string;
  appSecret: string;
  phoneNumberId: string;
  maxPayloadBytes: number;
  claimReceipt(waMessageId: string, kind: string, preview: string): Promise<"claimed" | "duplicate">;
  markReceipt(waMessageId: string, status: "processed" | "failed"): Promise<void>;
  handleInbound(message: {
    kind: "text" | "button" | "unsupported";
    from: string;
    waMessageId: string;
    text?: string;
    buttonId?: string;
    profileName?: string;
  }): Promise<void>;
}

export function mountWhatsappWebhook(app: RouteMount, deps: WebhookDeps | null): void {
  app.get("/webhook/whatsapp", (c) => handleVerification(deps, c));
  app.post("/webhook/whatsapp", (c) => handleEvents(deps, c));
}

function handleVerification(deps: WebhookDeps | null, c: Context): Response {
  if (!deps) return c.text("verification failed", 403);
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (challenge && mode === "subscribe" && verifyTokenMatch(deps.verifyToken, token)) {
    return c.text(challenge, 200);
  }
  return c.text("verification failed", 403);
}

async function handleEvents(deps: WebhookDeps | null, c: Context): Promise<Response> {
  if (!deps) return c.json({ error: "whatsapp channel offline" }, 401);

  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.length > deps.maxPayloadBytes) {
    return c.json({ error: "payload too large" }, 400);
  }
  const signedOk = signatureValid(deps.appSecret, (name) => c.req.header(name), rawBody);
  if (!signedOk) {
    return c.json({ error: "signature verification failed" }, 401);
  }

  const body = parseWebhookBodyJson(new TextDecoder().decode(rawBody));
  const events = parseWebhookEvents(body);

  for (const event of events) {
    if (event.kind === "message") {
      if (deps.phoneNumberId && event.phoneNumberId !== deps.phoneNumberId) {
        logger.warn("inbound_wrong_instance", {
          eventInstance: event.phoneNumberId || "(empty)",
          configuredInstance: deps.phoneNumberId,
          waMessageId: event.message.waMessageId,
        });
        continue;
      }
      const preview =
        event.message.kind === "text"
          ? `text="${event.message.text.slice(0, 80)}"`
          : event.message.kind === "button"
            ? `buttonId=${event.message.buttonId.slice(0, 40)}`
            : `type=${event.message.type}`;
      const receipt = await deps.claimReceipt(
        event.message.waMessageId,
        event.message.kind,
        preview,
      );
      if (receipt === "duplicate") continue;

      // Fast ACK contract: signature ok + receipt claimed => 200 to Meta now;
      // inference + outbound run asynchronously (serialized per sender).
      void deps
        .handleInbound(event.message)
        .then(() => deps.markReceipt(event.message.waMessageId, "processed"))
        .catch(() => deps.markReceipt(event.message.waMessageId, "failed"));
    } else if (event.kind === "status") {
      const receipt = await deps.claimReceipt(event.status.waMessageId, "status", event.status.status);
      if (receipt === "claimed") {
        // Delivery/read statuses are recorded and ignored (no agent work).
        await deps.markReceipt(event.status.waMessageId, "processed");
      }
    }
    // kind === "ignored": nothing actionable.
  }

  return c.json({ status: "processed" }, 200);
}
