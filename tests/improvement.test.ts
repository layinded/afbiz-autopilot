/**
 * Phase 4 self-improvement engine tests: versioned parser configs, the
 * regression gate, the full loop on a scripted improver, token-gated approval,
 * activation without restart, and rollback - all in the isolated test DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createStore, type Store } from "../db/store.js";
import { bindParserConfigStore, getActiveParserConfig, setActiveParserOverride, BASELINE_PARSER_CONFIG } from "../lib/parser-config.js";
import { parseAmount, parseAmountWithConfig } from "../tools/amounts.js";
import { runRegression } from "../improvement/regression.js";
import { createImprovementAgent } from "../improvement/agent.js";
import { runImprovementLoop } from "../improvement/loop.js";
import { createScriptedModel, type ScriptedModel } from "./helpers/scripted-model.js";
import { createEmitter, type Emitter } from "../lib/observability.js";
import { applyConfirmedPending, createBusinessTools } from "../tools/index.js";
import { executeTool, fakeOpOptions } from "./helpers/fakes.js";
import { cleanupTestDb, getSql, setupTestDb, TEST_OWNER, truncateAll } from "./helpers/test-db.js";

let store: Store;
let emitter: Emitter;
let improverModel: ScriptedModel;

beforeAll(async () => {
  await setupTestDb();
  store = createStore(getSql());
  emitter = createEmitter({ store, agentVersion: "0.1.0-p4test" });
  bindParserConfigStore(store);
  improverModel = createScriptedModel();
});
afterAll(async () => {
  setActiveParserOverride(undefined);
  bindParserConfigStore(null);
  await cleanupTestDb();
});
beforeEach(truncateAll);

const V2_CONFIG: import("../lib/parser-config.js").AmountParserConfig = {
  shorthand: [
    { suffix: "k", factor: 1000 },
    { suffix: "m", factor: 1_000_000 },
  ],
};

describe("versioned parser configuration", () => {
  it("the baseline config rejects shorthand while the improved config resolves it", () => {
    expect(parseAmountWithConfig("5k", BASELINE_PARSER_CONFIG).ok).toBe(false);
    const improved = parseAmountWithConfig("5k", V2_CONFIG);
    expect(improved.ok).toBe(true);
    if (improved.ok) expect(improved.value).toBe(5_000);
    const fractional = parseAmountWithConfig("2.5k", V2_CONFIG);
    expect(fractional.ok).toBe(true);
    if (fractional.ok) expect(fractional.value).toBe(2_500);
  });

  it("keeps working forms intact under the improved config", () => {
    for (const [input, expected] of [["₦5,000", 5000], ["5000", 5000], ["₦45,000", 45_000], ["₦12,000.50", 12_000.5]] as const) {
      const result = parseAmountWithConfig(input, V2_CONFIG);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(expected);
    }
  });

  it("activation flips the active pointer and parseAmount follows without a restart", async () => {
    setActiveParserOverride(undefined);
    await store.ensureParserVersion("parser_v1", { shorthand: [] });
    expect((await parseAmount("5k")).ok).toBe(false);

    await store.insertParserConfig("parser_v2", V2_CONFIG);
    await store.setActiveParserConfig("amount_parser", "parser_v2");
    bindParserConfigStore(store); // the running process re-reads within one TTL
    const result = await parseAmount("5k");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(5_000);
  });
});

describe("regression gate", () => {
  it("accepts the k/m candidate and rejects factor errors", () => {
    expect(runRegression(V2_CONFIG).passed).toBe(true);
    const badFactor = runRegression({ shorthand: [{ suffix: "k", factor: 100 }] });
    expect(badFactor.passed).toBe(false);
    const invalidShape = runRegression({ shorthand: [{ suffix: "x", factor: 1000 }] });
    expect(invalidShape.validConfig).toBe(false);
    const negative = runRegression({ shorthand: [{ suffix: "k", factor: 1_000 }, { suffix: "m", factor: 1_000_000 }] });
    expect(negative.passed).toBe(true);
  });
});

describe("customer payment path", () => {
  it("requires confirmation, applies exactly once, and decreases the balance once", async () => {
    setActiveParserOverride(BASELINE_PARSER_CONFIG);
    const tools = createPaymentToolsWith("record_customer_payment");
    const debtResponse = (await executeTool(tools.recordDebt, { customer_name: "Amina", description: "goods", amount_raw: "₦12,000" }, fakeOpOptions())) as Record<string, unknown>;
    expect(debtResponse["ok"]).toBe(true);

    const pending = await seedPendingPayment("Amina", 5_000);
    const claimed = await store.consumePending(TEST_OWNER, "confirm");
    expect(claimed).not.toBeNull();
    const applied = await applyConfirmedPending(store, claimed!);
    expect(applied.message).toContain("balance now ₦7,000");

    const balance = await tools.getCustomerBalance as never;
    void balance;
    const amina = await store.findCustomer(TEST_OWNER, "Amina");
    expect(amina).not.toBeNull();
    const outstanding = await store.customerBalance(TEST_OWNER, amina!.id);
    expect(outstanding.outstanding).toBe(7_000);

    const second = await store.consumePending(TEST_OWNER, "confirm");
    expect(second).toBeNull();
    expect(await getSql()`SELECT amount_paid FROM debts`).toHaveLength(1);
    void pending;
  });

  it("refuses overpayments at creation time", async () => {
    const tools = createPaymentToolsWith("record_customer_payment");
    await store.upsertCustomer(TEST_OWNER, "Amina");
    await store.insertDebt(TEST_OWNER, (await store.findCustomer(TEST_OWNER, "Amina"))!.id, { description: "goods", amount: 12_000, currency: "NGN" });
    const result = (await executeTool(
      tools.recordCustomerPayment,
      { customer_name: "Amina", amount_raw: "₦50,000" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("payment_exceeds_outstanding");
    expect(await getSql()`SELECT id FROM pending_actions WHERE tool = 'record_customer_payment'`).toHaveLength(0);
  });

  it("with the improved config the raw '5k' input resolves to ₦5,000", async () => {
    setActiveParserOverride(V2_CONFIG);
    const tools = createPaymentToolsWith("record_customer_payment");
    await store.upsertCustomer(TEST_OWNER, "Amina");
    await store.insertDebt(TEST_OWNER, (await store.findCustomer(TEST_OWNER, "Amina"))!.id, { description: "goods", amount: 12_000, currency: "NGN" });
    const result = (await executeTool(
      tools.recordCustomerPayment,
      { customer_name: "Amina", description: "from what she owes", amount_raw: "5k" },
      fakeOpOptions(),
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["confirmation_required"]).toBe(true);
    expect(String(result["message"])).toContain("₦5,000");
    setActiveParserOverride(BASELINE_PARSER_CONFIG);
  });
});

function createPaymentToolsWith(kind: "record_customer_payment") {
  const built = createBusinessTools(store, { confirmAmountThreshold: 1_000_000, tzOffsetMinutes: 60, emitter });
  expect(kind === "record_customer_payment" && typeof built.recordCustomerPayment).toBe("object");
  return built;
}

async function seedPendingPayment(customer: string, amount: number) {
  const amina = await store.findCustomer(TEST_OWNER, customer);
  expect(amina).not.toBeNull();
  return store.createPending(
    TEST_OWNER,
    "record_customer_payment",
    { customer_name: customer, description: "from what she owes", amount, currency: "NGN", customer_id: amina!.id },
    `record_customer_payment ${customer} — ₦${amount}`,
  );
}

describe("the improvement loop on a scripted improver", () => {
  it("proposes, regression-passes, requires approval, activates and rolls back", async () => {
    setActiveParserOverride(undefined);
    await store.ensureParserVersion("parser_v1", { shorthand: [] });

    await store.recordEventLedger({
      traceId: "t_fail_5k",
      event: "agent_tool_executed",
      tool: "record_customer_payment",
      agentVersion: "0.1.0",
      status: "failure",
      outcome: "amount_unparsable",
      failureCategory: "amount_parsing",
      payload: { raw_input: "5k", reply_preview: "Could you restate the amount?" },
    });

    improverModel.pushGenerate([
      JSON.stringify({
        changeType: "amount_normalization",
        patch: { shorthand: [{ suffix: "k", factor: 1000 }] },
        diagnosis: 'The owner writes "5k" as Naira shorthand; the parser lacks a k-multiplier rule so valid input was refused.',
        rationale: "Adding the standard k=1000 rule keeps existing forms working while resolving the refused shorthand.",
        risks: "",
      }),
    ]);
    const improver = createImprovementAgent({ model: improverModel });
    const loop = await runImprovementLoop({ store, emitter, improver, model: improverModel, agentVersion: "0.1.0" });

    expect(loop.status).toBe("proposed");
    expect(loop.version).toBe("parser_v2");
    expect(loop.regression?.passed).toBe(true);
    const proposal = await store.getProposal(loop.proposalId!);
    expect(proposal?.status).toBe("pending");
    expect(proposal?.approval_token_hash).not.toBe(loop.token);

    const rejected = await store.approveProposal(loop.proposalId!, "wrong-token");
    expect(rejected).toBeNull();

    const hashed = createHash("sha256").update(loop.token!).digest("hex");
    const activated = await store.approveProposal(loop.proposalId!, hashed);
    expect(activated?.status).toBe("approved");
    await store.insertParserConfig(activated!.version, activated!.config);
    await store.setActiveParserConfig("amount_parser", activated!.version);
    await store.insertImprovementAudit({ action: "activated", version: activated!.version, proposalId: loop.proposalId, actor: "admin-cli" });
    bindParserConfigStore(store);

    expect(await store.getActiveParserVersion("amount_parser")).toBe("parser_v2");
    const live = await parseAmount("5k");
    expect(live.ok).toBe(true);
    if (live.ok) expect(live.value).toBe(5_000);

    await store.setActiveParserConfig("amount_parser", "parser_v1");
    await store.insertImprovementAudit({ action: "rollback", version: "parser_v1", actor: "admin-cli", detail: { previousVersion: "parser_v2" } });
    bindParserConfigStore(store);
    expect(await parseAmount("5k").then((r) => r.ok)).toBe(false);
    const trail = await store.improvementAuditTrail(5);
    expect(trail.map((entry) => entry.action)).toContain("rollback");

    await store.setActiveParserConfig("amount_parser", "parser_v2");
    bindParserConfigStore(store);
    const restored = await parseAmount("5k");
    expect(restored.ok).toBe(true);
    expect((await getActiveParserConfig()).shorthand.length).toBeGreaterThan(0);
  });

  it("discards candidates that fail the regression gate", async () => {
    await store.ensureParserVersion("parser_v1", { shorthand: [] });
    await store.recordEventLedger({
      traceId: "t_fail_bad",
      event: "agent_tool_executed",
      tool: "record_expense",
      agentVersion: "0.1.0",
      status: "failure",
      outcome: "amount_unparsable",
      failureCategory: "amount_parsing",
      payload: { raw_input: "5k" },
    });
    improverModel.pushGenerate([
      JSON.stringify({
        changeType: "amount_normalization",
        patch: { shorthand: [] },
        diagnosis: "Declined to add rules without evidence.",
        rationale: "A patch with no rules still fails the required '5k' regression case on purpose.",
        risks: "leaves 5k unresolved",
      }),
    ]);
    const improver = createImprovementAgent({ model: improverModel });
    const loop = await runImprovementLoop({ store, emitter, improver, model: improverModel, agentVersion: "0.1.0" });
    expect(loop.status).toBe("tests_failed");
    const proposal = await store.getProposal(loop.proposalId!);
    expect(proposal?.status).toBe("rejected");
    expect((await store.getActiveParserVersion("amount_parser"))).toBe("parser_v1");
  });

  it("refuses non-allowlisted change types without any activation", async () => {
    await store.recordEventLedger({
      traceId: "t_fail_prompt",
      event: "agent_tool_executed",
      tool: "record_expense",
      agentVersion: "0.1.0",
      status: "failure",
      outcome: "amount_unparsable",
      failureCategory: "amount_parsing",
      payload: { raw_input: "5k" },
    });
    improverModel.pushGenerate([
      JSON.stringify({
        changeType: "prompt_injection",
        patch: { anyKey: "arbitrary" },
        diagnosis: "Attempted out-of-bounds change.",
        rationale: "Should be refused.",
        risks: "",
      }),
    ]);
    const improver = createImprovementAgent({ model: improverModel });
    const loop = await runImprovementLoop({ store, emitter, improver, model: improverModel, agentVersion: "0.1.0" });
    expect(loop.status).toBe("generation_rejected");
    expect(await getSql()`SELECT id FROM parse_configs WHERE version = 'parser_v2'`).toHaveLength(0);
  });
});
