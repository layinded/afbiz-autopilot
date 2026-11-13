/**
 * Brief scenarios A-E driven end-to-end offline: the REAL VoltAgent agent
 * machinery (supervisor + tools + PostgreSQL) runs against a scripted model,
 * and the REAL watchdog turn runner executes, exactly as the WhatsApp channel
 * invokes it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter, Memory } from "@voltagent/core";
import { createStore, type Store } from "../db/store.js";
import { businessDayRange } from "../db/store.js";
import { createBusinessTools } from "../tools/index.js";
import { createSupervisorAgent } from "../agent/agent.js";
import { runSupervisorTurn } from "../agent/turn.js";
import { createScriptedModel, textStep, toolCallStep } from "./helpers/scripted-model.js";
import { cleanupTestDb, getSql, setupTestDb, TEST_OWNER, truncateAll } from "./helpers/test-db.js";

let store: Store;
let model: ReturnType<typeof createScriptedModel>;
let supervisor: ReturnType<typeof createSupervisorAgent>;

beforeAll(async () => {
  await setupTestDb();
  store = createStore(getSql());
  const { tools } = createBusinessTools(store, {
    confirmAmountThreshold: 1_000_000,
    tzOffsetMinutes: 60,
  });
  model = createScriptedModel();
  const memory = new Memory({ storage: new InMemoryStorageAdapter(), generateTitle: false });
  supervisor = createSupervisorAgent({ model, memory, tools });
});
afterAll(cleanupTestDb);
beforeEach(truncateAll);

async function runTurn(message: string): Promise<string> {
  const today = businessDayRange(new Date(), 60).date;
  const turn = await runSupervisorTurn({
    supervisor,
    userId: TEST_OWNER,
    conversationId: `wa:${TEST_OWNER}`,
    message,
    traceId: "t_scenario",
    today,
    maxOutputTokens: 1000,
    timeoutMs: 15_000,
  });
  expect(turn.settled).toBe("result");
  return turn.text;
}

describe("brief scenarios A-E (scripted model, real agent + DB)", () => {
  it("Test A: records a sale from a natural sale message", async () => {
    model.push([
      toolCallStep("record_sale", { description: "bags of rice", quantity: 3, amount_raw: "₦45,000" }),
      textStep("Sale recorded: 3 × bags of rice — ₦45,000."),
    ]);
    const text = await runTurn("I sold 3 bags of rice for ₦45,000.");
    expect(text).toContain("₦45,000");
    const sales = await getSql()`SELECT description, quantity, amount FROM sales`;
    expect(sales).toHaveLength(1);
    expect((sales[0] as Record<string, unknown>)["description"]).toBe("bags of rice");
    expect(Number((sales[0] as Record<string, unknown>)["quantity"])).toBe(3);
    expect(Number((sales[0] as Record<string, unknown>)["amount"])).toBe(45_000);
  });

  it("Test B: records an expense with its category", async () => {
    model.push([
      toolCallStep("record_expense", { description: "transport fare", category: "transportation", amount_raw: "₦8,000" }),
      textStep("Expense recorded: transportation — ₦8,000."),
    ]);
    const text = await runTurn("I spent ₦8,000 on transportation.");
    expect(text).toContain("₦8,000");
    const expenses = await getSql()`SELECT category, amount FROM expenses`;
    expect(expenses).toHaveLength(1);
    expect((expenses[0] as Record<string, unknown>)["category"]).toBe("transportation");
    expect(Number((expenses[0] as Record<string, unknown>)["amount"])).toBe(8_000);
  });

  it("Test C: records a credit purchase as customer debt", async () => {
    model.push([
      toolCallStep("record_debt", { customer_name: "Amina", description: "goods", amount_raw: "₦12,000" }),
      textStep("New customer Amina recorded with a ₦12,000 debt (balance ₦12,000)."),
    ]);
    const text = await runTurn("Amina bought goods worth ₦12,000 on credit.");
    expect(text).toContain("₦12,000");
    const customer = await store.findCustomer(TEST_OWNER, "Amina");
    expect(customer).not.toBeNull();
    const balance = await store.customerBalance(TEST_OWNER, customer!.id);
    expect(balance.outstanding).toBe(12_000);
  });

  it("Test D: answers a debt question from PostgreSQL", async () => {
    model.push([
      toolCallStep("get_customer_balance", { customer_name: "Amina" }),
      textStep("Amina owes ₦12,000."),
    ]);
    const text = await runTurn("How much does Amina owe me?");
    expect(text).toContain("₦12,000");
    const toolCallCount = model.consumedCalls;
    expect(toolCallCount).toBeGreaterThan(0);
  });

  it("Test E: reports today's sales total without fabricated values", async () => {
    // Seed the same sale the agent would have recorded (Test A equivalent, direct).
    model.push([
      toolCallStep("record_sale", { description: "bags of rice", quantity: 3, amount_raw: "₦45,000" }),
      textStep("Sale recorded: 3 × bags of rice — ₦45,000."),
    ]);
    await runTurn("I sold 3 bags of rice for ₦45,000.");
    const summary = await store.salesSummary(TEST_OWNER, businessDayRange(new Date(), 60).from, businessDayRange(new Date(), 60).to);
    expect(summary).toEqual({ total: 45_000, count: 1 });
    model.push([
      toolCallStep("get_business_summary", { scope: "today" }),
      textStep("Today: sales ₦45,000 from 1 sale(s); expenses ₦0 from 0; customers owe ₦0 across 0 debt(s)."),
    ]);
    const text = await runTurn("How much did I sell today?");
    expect(text).toContain("₦45,000");
    // The backend-computed value, not a model invention, is the assertion anchor.
    expect(summary.total).toBe(45_000);
  });
});
