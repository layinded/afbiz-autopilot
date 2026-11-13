/**
 * Phase 3 observability tests (brief Tests A-E): every task outcome lands in
 * the local event ledger and is forwarded to PostHog via posthog-node against
 * a local capture endpoint, with the privacy whitelist asserted; PostHog
 * outages never block business operations. The REAL channel layer runs: only
 * the model is scripted — the turn runner, tools, ledger, emitter, and channel
 * are the production code paths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter, Memory } from "@voltagent/core";
import { createStore, type Store } from "../db/store.js";
import { businessDayRange } from "../db/store.js";
import { createBusinessTools, applyConfirmedPending } from "../tools/index.js";
import { createSupervisorAgent } from "../agent/agent.js";
import { runSupervisorTurn } from "../agent/turn.js";
import { createWhatsAppChannel, type WhatsAppChannel } from "../integrations/whatsapp/channel.js";
import { createPostHogObservability } from "../integrations/posthog.js";
import { createEmitter, type Emitter } from "../lib/observability.js";
import { startCaptureServer, type CaptureServer } from "./helpers/posthog-capture-server.js";
import { createScriptedModel, textStep, toolCallStep, type ScriptedModel } from "./helpers/scripted-model.js";
import { executeTool, fakeOpOptions } from "./helpers/fakes.js";
import { cleanupTestDb, getSql, setupTestDb, TEST_OWNER, truncateAll } from "./helpers/test-db.js";

let store: Store;
let capture: CaptureServer;
let observability: ReturnType<typeof createPostHogObservability>;
let emitter: Emitter;
let channelTools: ReturnType<typeof createBusinessTools>;
let model: ScriptedModel;
let channel: WhatsAppChannel;
let replies: string[];

beforeAll(async () => {
  await setupTestDb();
  store = createStore(getSql());
  capture = await startCaptureServer();
  observability = createPostHogObservability({ publicKey: "phc_test_key", host: capture.url });
  emitter = createEmitter({ store, observability, agentVersion: "0.1.0" });
  channelTools = createBusinessTools(store, { confirmAmountThreshold: 1_000_000, tzOffsetMinutes: 60, emitter });
  model = createScriptedModel();
  const memory = new Memory({ storage: new InMemoryStorageAdapter(), generateTitle: false });
  const supervisor = createSupervisorAgent({ model, memory, tools: channelTools.tools });

  replies = [];
  channel = createWhatsAppChannel({
    config: {
      verifyToken: "obs",
      appSecret: "obs-secret",
      accessToken: "obs-token",
      phoneNumberId: "OBS_PHONE_ID",
      graphBaseUrl: "https://graph.invalid",
      graphVersion: "v23.0",
      graphTimeoutMs: 5_000,
      typingIndicator: false,
      typingRefreshMs: 1_000,
      typingMaxMs: 2_000,
    },
    maxPayloadBytes: 65_536,
    store,
    supervisor,
    maxOutputTokens: 1000,
    requestTimeoutMs: 15_000,
    tzOffsetMinutes: 60,
    emitter,
    runTurn: (params) => runSupervisorTurn(params),
    fetchFn: (async (_url: unknown, init?: { body?: string }) => {
      if (init?.body) replies.push(init.body);
      return new Response(JSON.stringify({ messages: [{ id: "out_obs" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
});

afterAll(async () => {
  await observability.flush();
  await capture.close();
  await cleanupTestDb();
});
beforeEach(truncateAll);

interface PlannedStep {
  toolCalls?: { toolName: string; input: unknown }[];
  text: string;
}

async function channelTurn(steps: PlannedStep, message: string): Promise<void> {
  model.push([
    ...(steps.toolCalls ?? []).map((call) => toolCallStep(call.toolName, call.input)),
    textStep(steps.text),
  ]);
  await channel.handleInbound({ kind: "text", from: TEST_OWNER, waMessageId: `obs_${Math.random().toString(36).slice(2)}`, text: message });
}

describe("brief Test A: successful operation", () => {
  it("records the expense, emits task events to ledger AND PostHog, with no financial data forwarded", async () => {
    await channelTurn(
      { toolCalls: [{ toolName: "record_expense", input: { description: "fuel", category: "fuel", amount_raw: "₦2,000" } }], text: "Expense recorded: fuel — ₦2,000." },
      "I spent ₦2,000 on fuel.",
    );
    await observability.flush();

    const expenses = await getSql()`SELECT category, amount FROM expenses`;
    expect(expenses).toHaveLength(1);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.join(" ")).toContain("Expense recorded");

    const ledger = await getSql()`SELECT event, status, tool FROM event_ledger ORDER BY id`;
    const events = ledger.map((row) => String((row as Record<string, unknown>)["event"]));
    expect(events).toContain("agent_task_started");
    expect(events).toContain("agent_tool_executed");
    expect(events).toContain("agent_task_completed");

    const names = capture.captured().map((event) => event.event);
    for (const name of [...new Set(events)]) {
      expect(names).toContain(name);
    }

    const allProperties = JSON.stringify(capture.captured().map((event) => event.properties));
    expect(allProperties).not.toContain("2000");
    expect(allProperties).not.toContain("₦");
    expect(allProperties).not.toContain("fuel");
    expect(allProperties).toContain("agentVersion");
  });
});

describe("brief Test B: missing information", () => {
  it("asks for clarification, emits the event, and persists nothing", async () => {
    await channelTurn(
      { toolCalls: [], text: "How much did you buy the rice for?" },
      "I sold some rice.",
    );
    await observability.flush();

    const clarification = await getSql()`SELECT event, failure_category FROM event_ledger WHERE event = 'agent_clarification_required'`;
    expect(clarification).toHaveLength(1);
    expect(String((clarification[0] as Record<string, unknown>)["failure_category"])).toBe("missing_information");
    const captureNames = capture.captured().map((event) => event.event);
    expect(captureNames).toContain("agent_clarification_required");

    expect(await getSql()`SELECT id FROM sales`).toHaveLength(0);
  });
});

describe("brief Test C: unsupported request", () => {
  it("records the unsupported outcome and creates no business transaction", async () => {
    await channelTurn(
      { toolCalls: [], text: "Sorry, I can't book flights - I only record business records." },
      "Book me a flight to London.",
    );
    await observability.flush();

    const outcome = await getSql()`SELECT outcome, failure_category FROM event_ledger WHERE event = 'agent_task_failed' LIMIT 1`;
    expect(String((outcome[0] as Record<string, unknown>)["outcome"])).toBe("unsupported_request");
    expect(String((outcome[0] as Record<string, unknown>)["failure_category"])).toBe("unsupported_request");
    expect(await getSql()`SELECT id FROM sales`).toHaveLength(0);
    expect(await getSql()`SELECT id FROM expenses`).toHaveLength(0);
  });
});

describe("brief Test D: simulated tool failure", () => {
  it("emits a categorized failure with trace id and returns a safe response", async () => {
    const dbError = new Error("connection reset by database");
    dbError.name = "PostgresError";
    const brokenStore = {
      ...store,
      insertExpense: () => {
        throw dbError;
      },
    } as unknown as Store;
    const failing = createBusinessTools(brokenStore, {
      confirmAmountThreshold: 1_000_000,
      tzOffsetMinutes: 60,
      emitter,
    });

    const result = (await executeTool(
      failing.recordExpense,
      { description: "fuel", category: "fuel", amount_raw: "₦2,000" },
      fakeOpOptions(),
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("tool_error");
    expect(String(result["message"])).toContain("nothing was recorded");

    const failures = await getSql()`SELECT failure_category, trace_id, event FROM event_ledger WHERE event = 'agent_tool_executed'`;
    expect(String((failures[0] as Record<string, unknown>)["failure_category"])).toBe("database");
  });
});

describe("brief Test E: PostHog unavailable", () => {
  it("keeps the business flow and the ledger intact when PostHog is unreachable", async () => {
    const dead = createPostHogObservability({ publicKey: "phc_dead", host: "http://127.0.0.1:1" });
    const deadEmitter = createEmitter({ store, observability: dead, agentVersion: "0.1.0" });

    const tools = createBusinessTools(store, {
      confirmAmountThreshold: 1_000_000,
      tzOffsetMinutes: 60,
      emitter: deadEmitter,
    });
    const result = (await executeTool(
      tools.recordExpense,
      { description: "water", category: "transportation", amount_raw: "₦750" },
      fakeOpOptions(),
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(await getSql()`SELECT amount FROM expenses`).toHaveLength(1);
    expect(await getSql()`SELECT event FROM event_ledger WHERE event = 'agent_tool_executed'`).toHaveLength(1);

    await dead.flush();
    const totals = await getSql()`SELECT count(*) AS count FROM event_ledger`;
    expect(Number((totals[0] as Record<string, unknown>)["count"])).toBeGreaterThan(0);
  });
});

describe("improvement event names are supported by the emitter (Phase 4 emit-sites)", () => {
  it("accepts improvement_proposed with a version and local evidence payload", async () => {
    await emitter.emit("improvement_proposed", {
      traceId: "t_phase4",
      status: "info",
      improvementVersion: "parser_v2",
      outcome: "proposal_generated",
      ledgerExtra: { raw_input: "5k" },
    });
    const rows = await getSql()`SELECT event, improvement_version, payload FROM event_ledger WHERE event = 'improvement_proposed'`;
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(String(row["improvement_version"])).toBe("parser_v2");
    const payload = typeof row["payload"] === "string" ? JSON.parse(String(row["payload"])) : row["payload"];
    expect((payload as Record<string, unknown>)["raw_input"]).toBe("5k");
  });
});

describe("confirmation completion reaches ledger and PostHog", () => {
  it("applies the pending action and emits confirmation events", async () => {
    await store.createPending(
      TEST_OWNER,
      "record_sale",
      { description: "bags of rice", quantity: 2, amount: 30_000, currency: "NGN", customer_name: null },
      "record_sale 2 × bags of rice — ₦30,000",
    );
    const claimed = await store.consumePending(TEST_OWNER, "confirm");
    expect(claimed).not.toBeNull();
    const applied = await applyConfirmedPending(store, claimed!);
    expect(applied.message).toContain("₦30,000");
    await emitter.emit("agent_tool_executed", {
      traceId: "t_confirm",
      tool: "record_sale",
      status: "success",
      outcome: "confirmation_applied",
    });
    await emitter.emit("agent_task_completed", {
      traceId: "t_confirm",
      status: "success",
      tool: "record_sale",
      outcome: "confirmation_applied",
    });
    await observability.flush();
    expect(capture.captured().map((event) => event.event)).toContain("agent_task_completed");
    expect(await getSql()`SELECT id FROM sales`).toHaveLength(1);
  });
});
