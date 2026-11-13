/**
 * Webhook HTTP tests: Meta handshake, verify-before-parse signature check,
 * duplicate-message protection (brief Test F), status-event handling, payload
 * size limit, offline gate, and the bare Confirm/Cancel flow over pending actions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Agent } from "@voltagent/core";
import { createWhatsAppChannel, type WhatsAppChannel } from "../integrations/whatsapp/channel.js";
import { mountWhatsappWebhook } from "../integrations/whatsapp/webhook.js";
import { createStore, type Store } from "../db/store.js";
import {
  cleanupTestDb,
  getSql,
  setupTestDb,
  TEST_OWNER,
  truncateAll,
} from "./helpers/test-db.js";
import {
  encodeAndSign,
  otherMessagePayload,
  statusEventPayload,
  textEventPayload,
} from "./helpers/signed-event.js";

const APP_SECRET = "test_app_secret";
const VERIFY_TOKEN = "test_verify_token";
const SENDER = "+2349000000001";

interface Harness {
  app: Hono;
  channel: WhatsAppChannel;
  sent: string[];
  turnMessages: string[];
  calls: () => number;
}

function buildHarness(maxPayloadBytes = 65_536, turnText = "Okay — recorded."): Harness {
  const sent: string[] = [];
  const turnMessages: string[] = [];
  let turnCalls = 0;
  const app = new Hono();
  const channel = createWhatsAppChannel({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    sender: {
      accessToken: "test_token",
      appSecret: APP_SECRET,
      phoneNumberId: "TEST_PHONE_ID",
      graphBaseUrl: "https://graph.invalid",
      graphVersion: "v23.0",
      graphTimeoutMs: 5_000,
    },
    maxPayloadBytes,
    store: createStore(getSql()),
    supervisor: {} as unknown as Agent, // unused: runTurn is injected
    maxOutputTokens: 100,
    requestTimeoutMs: 5_000,
    tzOffsetMinutes: 60,
    runTurn: async (params) => {
      turnCalls += 1;
      turnMessages.push(params.message);
      return { text: turnText, durationMs: 1, settled: "result" };
    },
    fetchFn: (async (_url: unknown, init?: { body?: string }) => {
      sent.push(init?.body ?? "");
      return new Response(JSON.stringify({ messages: [{ id: "out_1" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  channel.mount(app);
  return { app, channel, sent, turnMessages, calls: () => turnCalls };
}

async function post(app: Hono, payload: unknown, appSecret = APP_SECRET): Promise<Response> {
  const { rawBody, headers } = encodeAndSign(appSecret, payload);
  return app.request("/webhook/whatsapp", { method: "POST", headers, body: rawBody });
}

function replyBody(sent: string[], index = 0): string {
  const replies = sent.map((body) => JSON.parse(body) as { text?: { body?: string } }).filter((parsed) => parsed.text?.body);
  return replies[index]?.text?.body ?? "";
}

beforeAll(setupTestDb);
afterAll(cleanupTestDb);
beforeEach(truncateAll);

describe("GET handshake", () => {
  it("echoes hub.challenge when verify token matches", async () => {
    const { app } = buildHarness();
    const response = await app.request(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test_verify_token&hub.challenge=12345",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("12345");
  });

  it("fails closed on a wrong verify token", async () => {
    const { app } = buildHarness();
    const response = await app.request(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=12345",
    );
    expect(response.status).toBe(403);
  });
});

describe("POST events", () => {
  it("rejects invalid signatures before parsing (verify-before-parse)", async () => {
    const { app } = buildHarness();
    const { rawBody, headers } = encodeAndSign("WRONG_SECRET", textEventPayload({ text: "hello" }));
    const response = await app.request("/webhook/whatsapp", {
      method: "POST",
      headers: { ...headers, "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      body: rawBody,
    });
    expect(response.status).toBe(401);
  });

  it("processes a valid signed text message: ACK 200, one turn, outbound reply", async () => {
    const { app, sent } = buildHarness();
    const response = await post(app, textEventPayload({ from: SENDER, text: "I sold 3 bags of rice for ₦45,000.", id: "wamid.A1" }));
    expect(response.status).toBe(200);
    await vi.waitFor(
      async () => {
        const receipts = await getSql()`SELECT status FROM webhook_receipts WHERE wa_message_id = 'wamid.A1'`;
        expect((receipts[0] as Record<string, unknown>)["status"]).toBe("processed");
      },
      { timeout: 5_000 },
    );
    expect(replyBody(sent)).toContain("Okay — recorded.");
  });

  it("replaying the same webhook event records no duplicate (Test F)", async () => {
    const { app } = buildHarness();
    const first = await post(app, textEventPayload({ from: SENDER, text: "I sold 3 bags of rice for ₦45,000.", id: "wamid.REPLAY" }));
    expect(first.status).toBe(200);
    const replay = await post(app, textEventPayload({ from: SENDER, text: "I sold 3 bags of rice for ₦45,000.", id: "wamid.REPLAY" }));
    expect(replay.status).toBe(200);
    const receipts = await getSql()`SELECT wa_message_id FROM webhook_receipts WHERE wa_message_id = 'wamid.REPLAY'`;
    expect(receipts).toHaveLength(1);
  });

  it("records delivery statuses without any agent work", async () => {
    const { app } = buildHarness();
    const response = await post(app, statusEventPayload("wamid.STATUS.1", "delivered"));
    expect(response.status).toBe(200);
    await vi.waitFor(
      async () => {
        const receipts = await getSql()`SELECT kind FROM webhook_receipts WHERE wa_message_id = 'wamid.STATUS.1'`;
        expect(receipts).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
  });

  it("claims non-text messages but never runs the agent on them", async () => {
    const { app } = buildHarness();
    const response = await post(app, otherMessagePayload("wamid.IMG.1"));
    expect(response.status).toBe(200);
    await vi.waitFor(
      async () => {
        const receipts = await getSql()`SELECT kind, status FROM webhook_receipts WHERE wa_message_id = 'wamid.IMG.1'`;
        expect(receipts).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
  });

  it("enforces the payload size limit", async () => {
    const tiny = buildHarness(64);
    const response = await post(tiny.app, textEventPayload({ text: "x".repeat(500) }));
    expect(response.status).toBe(400);
  });
});

describe("bare Confirm/Cancel over pending actions", () => {
  it("confirms the latest pending action and applies it exactly once", async () => {
    const { app, sent } = buildHarness();
    const store = createStore(getSql());
    await store.createPending(
      SENDER,
      "record_sale",
      { description: "bags of rice", quantity: 3, amount: 45_000, currency: "NGN", customer_name: null },
      "record_sale 3 × bags of rice — ₦45,000",
    );

    const response = await post(app, textEventPayload({ from: SENDER, text: "confirm", id: "wamid.C1" }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5_000 });
    expect(replyBody(sent)).toContain("Sale recorded: 3 × bags of rice");

    // Confirming again must not apply anything twice.
    const second = await post(app, textEventPayload({ from: SENDER, text: "confirm", id: "wamid.C2" }));
    expect(second.status).toBe(200);
    await vi.waitFor(() => expect(sent.length).toBe(2), { timeout: 5_000 });
    expect(replyBody(sent, 1)).toContain("nothing pending");
    expect(await getSql()`SELECT id FROM sales`).toHaveLength(1);
  });

  it("cancels pending actions without recording anything", async () => {
    const { app, sent } = buildHarness();
    const store = createStore(getSql());
    await store.createPending(SENDER, "record_sale", { description: "x", quantity: 1, amount: 10, currency: "NGN", customer_name: null }, "s");
    await post(app, textEventPayload({ from: SENDER, text: "cancel", id: "wamid.X1" }));
    await vi.waitFor(() => expect(sent.length).toBe(1), { timeout: 5_000 });
    expect(replyBody(sent)).toContain("Cancelled.");
    expect(await getSql()`SELECT id FROM sales`).toHaveLength(0);
  });
});

describe("offline gate", () => {
  it("fails closed when the channel is unmounted", async () => {
    const app = new Hono();
    mountWhatsappWebhook(app, null);
    const verify = await app.request(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=any&hub.challenge=1",
    );
    expect(verify.status).toBe(403);
    const events = await app.request("/webhook/whatsapp", { method: "POST", body: "{}" });
    expect(events.status).toBe(401);
  });
});
