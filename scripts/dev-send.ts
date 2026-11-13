/**
 * Local dev tool: sends a properly signed synthetic WhatsApp webhook event to
 * the local service - the same shape Meta will send - so Tests A-G can be
 * driven against localhost without touching the production integration.
 *
 *   npm run dev -- --mode handshake    (or: tsx --env-file-if-exists=.env scripts/dev-send.ts --mode handshake)
 *   tsx --env-file-if-exists=.env scripts/dev-send.ts --text "I sold 3 bags of rice for ₦45,000." \
 *       --from +2349000000001 --id fixed-id-1   # same --id again = replay (Test F)
 *
 * Requires .env with WHATSAPP_* placeholders (any app secret works for
 * localhost signing; Meta is not involved). The server must run with
 * WHATSAPP_ENABLED=1 to accept events.
 */
import { createHmac, randomUUID } from "node:crypto";
import { logger } from "../lib/config.js";

interface Args {
  url: string;
  from: string;
  text: string;
  id?: string;
  mode: "handshake" | "send";
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    url: get("url") ?? "http://localhost:3141/webhook/whatsapp",
    from: get("from") ?? "+2349000000001",
    text: get("text") ?? "hi",
    id: get("id"),
    mode: get("mode") === "handshake" ? "handshake" : "send",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const appSecret = process.env["WHATSAPP_APP_SECRET"];
  const verifyToken = process.env["WHATSAPP_VERIFY_TOKEN"];

  if (args.mode === "handshake") {
    if (!verifyToken) throw new Error("WHATSAPP_VERIFY_TOKEN missing from env");
    const handshakeUrl = `${args.url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=12345`;
    const response = await fetch(handshakeUrl);
    const body = await response.text();
    console.log(`HANDSHAKE status=${response.status} body=${body?.slice(0, 100)}`);
    process.exit(response.status === 200 && body === "12345" ? 0 : 1);
  }

  const messageId = args.id ?? `devmsg_${randomUUID()}`;
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "DEV_BUSINESS_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "2349000000000", phone_number_id: process.env["WHATSAPP_PHONE_NUMBER_ID"]?.trim() || "DEV_PHONE_ID" },
              contacts: [{ profile: { name: "Dev Sender" }, wa_id: args.from.replace(/^\+/, "") }],
              messages: [
                {
                  from: args.from.replace(/^\+/, ""),
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  text: { body: args.text },
                  type: "text",
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const rawBody = JSON.stringify(payload);
  if (!appSecret) throw new Error("WHATSAPP_APP_SECRET missing from env");
  const signature = `sha256=${createHmac("sha256", appSecret).update(new Uint8Array(Buffer.from(rawBody, "utf8"))).digest("hex")}`;

  const response = await fetch(args.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: rawBody,
  });
  const body = await response.text();
  console.log(`SEND status=${response.status} body=${body}`);
  if (args.id) console.log(`messageId=${messageId} (re-run with the same flag to test idempotency)`);
  process.exit(response.status === 200 ? 0 : 1);
}

main().catch((error) => {
  logger.error("dev_send_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
